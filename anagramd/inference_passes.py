"""Schedule one detector forward pass at a time across native scoring requests."""
import threading
from contextlib import contextmanager
from contextvars import ContextVar


class ScoreCancelled(Exception):
    pass


# Set by the stdio worker, scoped to its request. Direct detector callers use viewport priority.
request_context = ContextVar("inference_request", default=("viewport", None))
PRIORITIES = {"viewport": 2, "near": 1, "background": 0}


class PassQueue:
    def __init__(self):
        self.condition = threading.Condition()
        self.waiting = []
        self.running = False
        self.turn = 0

    @contextmanager
    def acquire(self):
        priority, cancellation = request_context.get()
        ticket = (PRIORITIES[priority], object())
        with self.condition:
            self.waiting.append(ticket)

            def next_pass():
                if self.running:
                    return False
                chosen = self.waiting[0] if self.turn % 5 == 0 else max(self.waiting, key=lambda t: t[0])
                return chosen is ticket

            self.condition.wait_for(next_pass)
            self.waiting.remove(ticket)
            if cancellation is not None and cancellation.is_set():
                self.condition.notify_all()
                raise ScoreCancelled()
            self.running = True
            self.turn += 1
        try:
            yield
        finally:
            with self.condition:
                self.running = False
                self.condition.notify_all()
