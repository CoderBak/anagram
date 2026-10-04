// entrypoints/shadow.content.ts — the one script Anagram runs in the page's own world.
//
// It says THAT a shadow root was attached, and on which element: a web component defined
// after the walk passed its host renders into a root that changes nothing the content
// script can observe from its isolated world. It reads nothing, sends nothing and keeps
// nothing — the content script (lib/capture/observers.ts) hears the event on the document
// and reads the root itself. Registered next to the content script, on the same granted
// sites, at document_start so that it is in place before the page's own scripts run
// (lib/access/worker.ts).
//
// The page is not to notice it, so that nothing it does can tell a page Anagram is there:
//   · The event has no name of its own: one is drawn at random for each document and told
//     once, before the page's first script, to the isolated companion registered just
//     before this script (entrypoints/shadowPort.content.ts, lib/dom/shadow.ts). The page
//     has no name to listen for, then or later.
//   · attachShadow is a Proxy of itself, and Function.prototype.toString shows the native
//     text for it and for itself, so both answer every usual check as the natives do: the
//     text, name and length, no `prototype`, the property's flags, `new` and `extends`
//     refused as the native refuses them, a prototype cycle refused, and an error thrown by
//     the native with the stack it would have had, this script's frames taken out (in
//     Chrome they would name the extension).
//   · Everything it uses once the page runs was taken before the page could replace it.
// What stays visible in principle: another frame's Function.prototype.toString shows a Proxy
// where it looks at this frame's functions (each frame's knows its own only); a page's own
// Proxy in the chain given to setPrototypeOf is looked through; Reflect.setPrototypeOf with a
// cycle throws where the native returns false; in Firefox an error thrown through it keeps
// its stack as a property of its own; a page that sets Error.stackTraceLimit very low sees
// one frame fewer; a getter or a toString of the page's own in the init it passes runs with
// this script's frame under it, which names the extension in Chrome (in Firefox it is
// "<anonymous code>"); and time.
import { defineContentScript } from "#imports";
import { SHADOW_PORT_EVENT } from "../lib/dom/shadow";

export default defineContentScript({
  registration: "runtime",
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN",
  // No `var shadow = …` on the page's own window.
  globalName: false,
  main() {
    const proto = Element.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "attachShadow");
    const original = descriptor?.value as Element["attachShadow"] | undefined;
    const toStringDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
    const nativeToString = toStringDescriptor?.value as typeof Function.prototype.toString | undefined;
    if (!descriptor || typeof original !== "function" || !toStringDescriptor || typeof nativeToString !== "function") return;

    // What runs after the page's scripts start, taken now.
    const apply: (target: Function, self: unknown, args: ArrayLike<unknown>) => any = Reflect.apply;
    const dispatch = EventTarget.prototype.dispatchEvent;
    const EventClass = Event;
    const indexOf = String.prototype.indexOf;
    const slice = String.prototype.slice;
    const masked = new WeakMap<object, unknown>();
    const maskedAs = WeakMap.prototype.get;
    // An init the page cannot add to: Event reads its members from the prototype chain too.
    const init = Object.setPrototypeOf({ bubbles: true, composed: true }, null) as EventInit;

    const letters = new Uint8Array(20);
    crypto.getRandomValues(letters);
    const name = String.fromCharCode(...Array.from(letters, (b) => 97 + (b % 26)));

    // Where this script's own frames are in a stack trace: its address in Chrome, the place
    // Firefox gives a page-world script.
    const here = (() => {
      for (const line of (new Error().stack ?? "").split("\n")) {
        const m = /(?:\(|@|at )([^()@]+?):\d+:\d+\)?$/.exec(line.trim());
        if (m) return m[1]!;
      }
      return null;
    })();
    /**
     * The error as the native would have thrown it: without this script's frames, and, where
     * the page reached this script through a native of its own (Object.setPrototypeOf), without
     * the native frame this script called in its place (Chrome lists natives as "(<anonymous>)").
     */
    const unseen = (error: unknown, throughNative = false): unknown => {
      if (!here || typeof error !== "object" || error === null) return error;
      try {
        const stack = (error as { stack?: unknown }).stack;
        if (typeof stack !== "string" || apply(indexOf, stack, [here]) < 0) return error;
        let kept = "";
        let any = false;
        let pending: string | null = null;
        const keep = (line: string): void => {
          kept += any ? `\n${line}` : line;
          any = true;
        };
        for (let at = 0; at <= stack.length; ) {
          let end = apply(indexOf, stack, ["\n", at]) as number;
          if (end < 0) end = stack.length;
          const line = apply(slice, stack, [at, end]) as string;
          const ours = apply(indexOf, line, [here]) >= 0;
          if (pending !== null && !(ours && throughNative && apply(indexOf, pending, ["(<anonymous>)"]) >= 0)) keep(pending);
          pending = ours ? null : line;
          at = end + 1;
        }
        if (pending !== null) keep(pending);
        (error as { stack?: unknown }).stack = kept;
      } catch {
        /* a stack that cannot be written stays as it is */
      }
      return error;
    };
    const getPrototypeOf = Reflect.getPrototypeOf;
    const setPrototypeOf = Reflect.setPrototypeOf;
    const setPrototypeOrThrow = Object.setPrototypeOf;
    /** A prototype that would lead back to the function is refused with the native's own
     *  error: the native sees the cycle, while a Proxy on the way ends its search (and the
     *  function then had itself in its own chain). */
    const refuseCycles = <T extends object>(target: T, prototype: object | null): boolean => {
      try {
        for (let p = prototype, n = 0; p !== null && n < 10_000; p = getPrototypeOf(p), n++) {
          if (p === target || apply(maskedAs, masked, [p]) === target) setPrototypeOrThrow(target, target);
        }
        if (!setPrototypeOf(target, prototype)) setPrototypeOrThrow(target, prototype);
      } catch (error) {
        throw unseen(error, true);
      }
      return true;
    };

    // Adapted from FluentRead, installShadowRouteBridgeCore in
    // src/platform/shadow-ui/pageBridgeCore.ts (https://github.com/FluentRead/FluentRead),
    // GPL-3.0, © the FluentRead contributors. Only the attachShadow wrapper is taken; the
    // event goes out for closed roots too, which the content script reads through the
    // extension API.
    const attachShadow = new Proxy(original, {
      apply(target, host: Element, args: unknown[]) {
        let root: ShadowRoot;
        try {
          // The page's own arguments, as it passed them: a bad one must throw what it throws.
          root = apply(target, host, args) as ShadowRoot;
        } catch (error) {
          throw unseen(error);
        }
        try {
          apply(dispatch, host, [new EventClass(name, init)]);
        } catch {
          /* a page that broke its own event API still gets its root */
        }
        return root;
      },
      setPrototypeOf: refuseCycles,
    });
    // Adapted from uBlock Origin, proxyToStringFn in src/js/resources/proxy-apply.js
    // (https://github.com/gorhill/uBlock), GPL-3.0, © Raymond Hill: Function.prototype.toString
    // answers for a Proxy with the text of the function behind it, itself included.
    const toString = new Proxy(nativeToString, {
      apply(target, self: unknown, args: unknown[]) {
        const behind = apply(maskedAs, masked, [self]);
        try {
          return apply(target, behind === undefined ? self : behind, args);
        } catch (error) {
          throw unseen(error);
        }
      },
      setPrototypeOf: refuseCycles,
    });
    masked.set(attachShadow, original);
    masked.set(toString, nativeToString);
    try {
      Object.defineProperty(proto, "attachShadow", { ...descriptor, value: attachShadow });
      Object.defineProperty(Function.prototype, "toString", { ...toStringDescriptor, value: toString });
    } catch {
      /* a page that froze the prototype keeps it as it is */
    }
    // The name, to the isolated companion, which is listening already.
    document.dispatchEvent(new CustomEvent(SHADOW_PORT_EVENT, { detail: name }));
  },
});
