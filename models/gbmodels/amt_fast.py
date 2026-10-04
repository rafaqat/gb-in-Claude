# SPDX-License-Identifier: MIT
# Copyright (c) 2026 rafaqat
"""A faster add_token() for the Anticipatory Music Transformer, used through anticipation's own generate() loop.

Two changes, same model and same sampling rules:
  1. Exact prefix KV cache: if the cached input is a prefix of the new input, only the new tokens run through the
     model; otherwise everything is recomputed. The shipped sampler re-runs the whole window for every token.
     (The window slides and times are re-based, so a cache that is not exact-prefix would be wrong.)
  2. No boolean-mask writes: masked_fill instead of logits[mask] = -inf, so MPS does not run nonzero(), which waits
     for the GPU. One GPU→CPU read per token remains: the sampled token decides the next step.
"""
import torch
import torch.nn.functional as F
from anticipation import ops, sample
from anticipation.config import *  # noqa: F403 (CONTROL_OFFSET, …)
from anticipation.vocab import *  # noqa: F403

NEG_INF = -float("inf")


class PrefixCache:
    def __init__(self):
        self.window_start = 0  # chunked mode: where the history window starts (moves in jumps)
        self.ids: list[int] = []
        self.past = None
        self.hits = self.misses = 0
        self.events = 0      # events this generation produced (for the budget)
        self.capped = False  # True when the budget ended the generation early

    def logits(self, model, ids: list[int]) -> torch.Tensor:
        n = len(self.ids)
        if self.past is not None and 0 < n < len(ids) and ids[:n] == self.ids:
            new = torch.tensor(ids[n:], device=model.device).unsqueeze(0)
            out = model(new, past_key_values=self.past, use_cache=True)
            self.hits += 1
        else:
            out = model(torch.tensor(ids, device=model.device).unsqueeze(0), use_cache=True)
            self.misses += 1
        self.ids, self.past = list(ids), out.past_key_values
        return out.logits[0, -1]


def nucleus(logits, top_p):
    if top_p >= 1.0:
        return logits
    sorted_logits, sorted_indices = torch.sort(logits, descending=True)
    cumulative = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
    remove = cumulative > top_p
    remove[1:] = remove[:-1].clone()
    remove[0] = False
    return logits.masked_fill(remove.scatter(0, sorted_indices, remove), NEG_INF)


WINDOW = 1017  # the shipped sampler's history window (model context 1024 − 1 prefix token − 6 for the new event)


def window_start(cache: PrefixCache, n: int, chunk: int) -> int:
    """chunk = 0: exactly the shipped window (the last 1017 tokens). chunk > 0: when the window is full, drop `chunk`
    events at once, so the cache keeps hitting until the window is full again (context 1017 − 3·chunk … 1017)."""
    if chunk <= 0:
        return max(n - WINDOW, 0)
    if n - cache.window_start > WINDOW:
        cache.window_start = n - (WINDOW - 3 * chunk)
    return cache.window_start


def instrument_mask(instruments, size: int) -> torch.Tensor:
    """Additive mask over the vocabulary: note tokens of instruments outside `instruments` get −inf.
    Song JSON tracks are fixed, so an infill must not invent an instrument it has nowhere to put."""
    mask = torch.zeros(size)
    mask[NOTE_OFFSET:NOTE_OFFSET + MAX_NOTE] = NEG_INF  # noqa: F405
    for instr in instruments:
        mask[NOTE_OFFSET + instr * MAX_PITCH:NOTE_OFFSET + (instr + 1) * MAX_PITCH] = 0.0  # noqa: F405
    return mask


def make_add_token(cache: PrefixCache, greedy: bool = False, window_chunk: int = 0, instruments=None, budget=None):
    """budget: {max_events, deadline (time.monotonic() value or None), end_tick}. A runaway take (seed 3 once wrote
    4,235 notes in 8 bars and took 229 s) is ended by returning a time past the span, so generate() stops normally."""
    import time
    allowed = {}  # device → mask, built on first use

    def add_token(model, z, tokens, top_p, current_time, debug=False):
        if budget is not None and (cache.events >= budget["max_events"] or (budget["deadline"] is not None and time.monotonic() >= budget["deadline"])):
            cache.capped = True
            return [TIME_OFFSET + budget["end_tick"], DUR_OFFSET, NOTE_OFFSET]  # noqa: F405 — "after the end": generate() stops
        cache.events += 1
        assert len(tokens) % 3 == 0
        history = tokens[window_start(cache, len(tokens), window_chunk):]
        offset = ops.min_time(history, seconds=False)
        history = list(history)
        history[::3] = [tok - offset for tok in history[::3]]
        new_token = []
        with torch.no_grad():
            for i in range(3):
                ids = z + history + new_token
                logits = cache.logits(model, ids).float()  # sample in float32 whatever the model's dtype
                logits = sample.safe_logits(logits, len(ids) - 1)  # slice writes: no sync
                if i == 0:
                    logits = sample.future_logits(logits, current_time - offset)
                elif i == 2:
                    logits = sample.instr_logits(logits, tokens)
                    if instruments is not None:
                        if logits.device not in allowed:
                            allowed[logits.device] = instrument_mask(instruments, logits.shape[0]).to(logits.device)
                        logits = logits + allowed[logits.device]
                if greedy:
                    token = int(torch.argmax(logits))
                else:
                    token = int(torch.multinomial(F.softmax(nucleus(logits, top_p), dim=-1), 1))
                new_token.append(token)
        new_token[0] += offset
        return new_token
    return add_token


def generate_fast(model, start_time, end_time, inputs=None, controls=None, top_p=1.0, greedy=False, window_chunk=0, instruments=None):
    """anticipation.sample.generate with the cached add_token swapped in; returns (events, cache)."""
    cache = PrefixCache()
    shipped = sample.add_token
    sample.add_token = make_add_token(cache, greedy, window_chunk, instruments)
    try:
        events = sample.generate(model, start_time, end_time, inputs=inputs, controls=controls, top_p=top_p)
    finally:
        sample.add_token = shipped
    return events, cache
