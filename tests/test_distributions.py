import numpy as np
import pytest

from src.generator import distributions as dist


@pytest.fixture
def rng() -> np.random.Generator:
    return np.random.default_rng(0)


def test_scalar_spec_is_a_constant(rng: np.random.Generator) -> None:
    values = dist.draw(2.5, rng, 5)
    assert np.all(values == 2.5)


def test_minimum_is_applied_as_a_physical_bound(rng: np.random.Generator) -> None:
    values = dist.draw({"dist": "normal", "mu": 0.0, "sigma": 5.0, "min": 0.0}, rng, 500)
    assert values.min() >= 0.0


def test_shift_moves_support_without_clipping(rng: np.random.Generator) -> None:
    values = dist.draw({"dist": "lognormal", "mu": 0.0, "sigma": 0.5, "shift": 1.0}, rng, 500)
    assert values.min() > 1.0
    assert len(np.unique(values)) == len(values)


def test_negative_binomial_matches_requested_mean(rng: np.random.Generator) -> None:
    values = dist.draw(
        {"dist": "negative_binomial", "mean": 4.0, "dispersion": 2.0}, rng, 20000
    )
    assert values.mean() == pytest.approx(4.0, rel=0.1)
    assert values.var() > values.mean()


def test_discrete_only_returns_configured_values(rng: np.random.Generator) -> None:
    values = dist.draw({"dist": "discrete", "values": [1, 2, 3], "weights": [1, 1, 1]}, rng, 200)
    assert set(np.unique(values)).issubset({1, 2, 3})


def test_mixture_normal_is_multimodal(rng: np.random.Generator) -> None:
    spec = {
        "dist": "mixture_normal",
        "means": [0.0, 20.0],
        "sigmas": [0.5, 0.5],
        "weights": [0.5, 0.5],
    }
    values = dist.draw(spec, rng, 2000)
    assert ((values > 10).mean()) == pytest.approx(0.5, abs=0.1)


def test_draw_by_profile_routes_each_row_to_its_own_spec(rng: np.random.Generator) -> None:
    specs = {"low": 1.0, "high": 100.0}
    profiles = np.array(["low", "high", "low", "high"])
    values = dist.draw_by_profile(specs, profiles, rng)
    assert list(values) == [1.0, 100.0, 1.0, 100.0]


def test_loguniform_stays_inside_its_range(rng: np.random.Generator) -> None:
    values = dist.draw({"dist": "loguniform", "low": 0.02, "high": 0.2}, rng, 2000)
    assert values.min() >= 0.02 and values.max() <= 0.2
    assert np.median(values) == pytest.approx(np.sqrt(0.02 * 0.2), rel=0.1)


@pytest.mark.parametrize(
    "spec",
    [
        {"dist": "beta", "a": 2.0, "b": 2.0},
        {"dist": "gamma", "shape": 1.8, "scale": 0.55},
        {"dist": "lognormal", "mu": 0.15, "sigma": 0.45, "shift": 1.0},
    ],
)
def test_expected_value_matches_the_sample_mean(spec, rng: np.random.Generator) -> None:
    assert dist.draw(spec, rng, 200000).mean() == pytest.approx(dist.expected_value(spec), rel=0.02)


def test_expected_value_refuses_bounded_specs() -> None:
    with pytest.raises(ValueError):
        dist.expected_value({"dist": "gamma", "shape": 1.0, "scale": 1.0, "min": 0.5})


def test_same_seed_reproduces_draws() -> None:
    spec = {"dist": "gamma", "shape": 2.0, "scale": 3.0}
    first = dist.draw(spec, np.random.default_rng(11), 50)
    second = dist.draw(spec, np.random.default_rng(11), 50)
    assert np.array_equal(first, second)
