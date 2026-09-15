"""Shared fixtures. Tests run a reduced simulation so the suite stays fast."""

from __future__ import annotations

import copy
from typing import Any, Dict

import numpy as np
import pytest

from src.generator import config as config_module
from src.generator.activity import simulate
from src.generator.features import build_features
from src.generator.population import build_population

SMALL_AGENTS = 60
SMALL_DAYS = 60


@pytest.fixture(scope="session")
def full_config() -> Dict[str, Any]:
    return config_module.load_config(config_module.GENERATOR_CONFIG)


@pytest.fixture(scope="session")
def cfg(full_config: Dict[str, Any]) -> Dict[str, Any]:
    reduced = copy.deepcopy(full_config)
    reduced["simulation"]["num_agents"] = SMALL_AGENTS
    reduced["simulation"]["num_days"] = SMALL_DAYS
    return reduced


@pytest.fixture(scope="session")
def model_config() -> Dict[str, Any]:
    return config_module.load_config(config_module.MODEL_CONFIG)


def build_everything(cfg: Dict[str, Any]):
    rng = np.random.default_rng(int(cfg["seed"]))
    population = build_population(cfg, rng)
    observable, internal = simulate(cfg, population, rng)
    features = build_features(observable, cfg)
    return population, observable, internal, features


@pytest.fixture(scope="session")
def generated(cfg: Dict[str, Any]):
    return build_everything(cfg)
