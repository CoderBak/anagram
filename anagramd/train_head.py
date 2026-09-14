"""train_head.py — the classification head EditLens trains on top of a decoder LM.

Verbatim from the reference repository (github.com/pangramlabs/EditLens, scripts/train.py):
the saved LoRA adapters carry `score.norm.*` and `score.linear.weight`, so the base model's
plain Linear score head must be swapped for this module before the adapter is loaded.
"""
from __future__ import annotations

import torch


class NormedLinear(torch.nn.Module):
    """Linear layer preceded by LayerNorm to keep logits well-scaled."""

    def __init__(self, hidden_size: int, num_labels: int, device=None, dtype=None):
        super().__init__()
        self.norm = torch.nn.LayerNorm(hidden_size, device=device, dtype=dtype)
        self.linear = torch.nn.Linear(hidden_size, num_labels, bias=False, device=device, dtype=dtype)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.linear(self.norm(x))
