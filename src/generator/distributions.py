"""Random draws described entirely by configuration specs.

No distribution parameter is hardcoded here. A spec is either a bare number
(a constant) or a mapping of the form {dist: <name>, <params>, shift, min, max}.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

import numpy as np

Spec = Mapping[str, Any] | float | int


def _normal(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.normal(float(spec["mu"]), float(spec["sigma"]), n)


def _lognormal(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.lognormal(float(spec["mu"]), float(spec["sigma"]), n)


def _uniform(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.uniform(float(spec["low"]), float(spec["high"]), n)


def _loguniform(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return np.exp(rng.uniform(np.log(float(spec["low"])), np.log(float(spec["high"])), n))


def _beta(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.beta(float(spec["a"]), float(spec["b"]), n)


def _gamma(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.gamma(float(spec["shape"]), float(spec["scale"]), n)


def _exponential(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.exponential(float(spec["scale"]), n)


def _poisson(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.poisson(float(spec["lam"]), n).astype(float)


def _negative_binomial(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    """Gamma-Poisson mixture parameterised by mean and dispersion (gamma shape)."""
    mean = float(spec["mean"])
    dispersion = float(spec["dispersion"])
    rates = rng.gamma(dispersion, mean / dispersion, n)
    return rng.poisson(rates).astype(float)


def _discrete(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    values = np.asarray(spec["values"])
    weights = np.asarray(spec["weights"], dtype=float)
    return rng.choice(values, size=n, p=weights / weights.sum())


def _mixture_normal(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    means = np.asarray(spec["means"], dtype=float)
    sigmas = np.asarray(spec["sigmas"], dtype=float)
    weights = np.asarray(spec["weights"], dtype=float)
    components = rng.choice(len(means), size=n, p=weights / weights.sum())
    return rng.normal(means[components], sigmas[components])


def _bernoulli(spec: Mapping[str, Any], rng: np.random.Generator, n: int) -> np.ndarray:
    return (rng.random(n) < float(spec["p"])).astype(float)


_DISPATCH = {
    "normal": _normal,
    "lognormal": _lognormal,
    "uniform": _uniform,
    "loguniform": _loguniform,
    "beta": _beta,
    "gamma": _gamma,
    "exponential": _exponential,
    "poisson": _poisson,
    "negative_binomial": _negative_binomial,
    "discrete": _discrete,
    "mixture_normal": _mixture_normal,
    "bernoulli": _bernoulli,
}


def _apply_bounds(values: np.ndarray, spec: Mapping[str, Any]) -> np.ndarray:
    shift = spec.get("shift")
    if shift is not None:
        values = values + float(shift)
    low = spec.get("min")
    high = spec.get("max")
    if low is not None or high is not None:
        values = np.clip(values, low, high)
    return values


def draw(spec: Spec, rng: np.random.Generator, n: int) -> np.ndarray:
    """Draw n values from a spec. Non-mapping specs are treated as constants."""
    if not isinstance(spec, Mapping):
        return np.full(n, float(spec))
    values = _DISPATCH[spec["dist"]](spec, rng, n)
    if values.dtype.kind in "fiu":
        return _apply_bounds(values.astype(float), spec)
    return values


def draw_one(spec: Spec, rng: np.random.Generator) -> float:
    return float(draw(spec, rng, 1)[0])


_MEANS = {
    "normal": lambda s: float(s["mu"]),
    "lognormal": lambda s: float(np.exp(float(s["mu"]) + float(s["sigma"]) ** 2 / 2.0)),
    "uniform": lambda s: (float(s["low"]) + float(s["high"])) / 2.0,
    "beta": lambda s: float(s["a"]) / (float(s["a"]) + float(s["b"])),
    "gamma": lambda s: float(s["shape"]) * float(s["scale"]),
    "exponential": lambda s: float(s["scale"]),
}


def expected_value(spec: Spec) -> float:
    """Analytic mean of a spec. Bounded specs are refused, since clipping moves the mean."""
    if not isinstance(spec, Mapping):
        return float(spec)
    if spec.get("min") is not None or spec.get("max") is not None:
        raise ValueError("expected_value does not support specs with min or max bounds")
    if spec["dist"] not in _MEANS:
        raise NotImplementedError(f"no analytic mean for {spec['dist']}")
    return _MEANS[spec["dist"]](spec) + float(spec.get("shift") or 0.0)


def draw_by_profile(
    specs: Mapping[str, Spec],
    profiles: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    """Draw one value per row, choosing the spec named by that row's profile."""
    out = np.zeros(len(profiles), dtype=float)
    for name, spec in specs.items():
        mask = profiles == name
        count = int(mask.sum())
        if count:
            out[mask] = draw(spec, rng, count)
    return out


def bernoulli(probabilities: np.ndarray | float, rng: np.random.Generator, n: int) -> np.ndarray:
    return rng.random(n) < probabilities


def weighted_choice(
    options: Sequence[str],
    weights: Sequence[float],
    rng: np.random.Generator,
    n: int,
) -> np.ndarray:
    probabilities = np.asarray(weights, dtype=float)
    return rng.choice(np.asarray(options), size=n, p=probabilities / probabilities.sum())
