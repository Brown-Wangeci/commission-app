import numpy as np
import pytest

from src.generator import distributions as dist
from src.generator.typologies import (
    FLAG_COLUMNS,
    FRAUD_TYPOLOGIES,
    LEGIT_MODES,
    _careful_probability,
)


def test_careful_share_is_the_population_average_careful_probability(full_config) -> None:
    """careful_share must mean what its config comment says, with no hidden multiplier."""
    rng = np.random.default_rng(0)
    cautions = dist.draw(full_config["population"]["agent_caution"], rng, 20000)
    for typology in FRAUD_TYPOLOGIES:
        typology_rows = np.array([typology])
        mean_probability = np.mean(
            [_careful_probability(full_config, typology_rows, np.array([True]), c)[0] for c in cautions]
        )
        expected = float(full_config["fraud_behaviour"]["careful_share"][typology])
        assert mean_probability == pytest.approx(expected, rel=0.03)


def test_honest_agents_never_commit_fraud(generated) -> None:
    _, _, internal, _ = generated
    labels = internal.labels
    assert labels.loc[labels["honesty_type"] == "honest", "is_fraudulent"].sum() == 0


def test_fraud_only_comes_from_the_dishonest_types(generated) -> None:
    _, _, internal, _ = generated
    labels = internal.labels
    offenders = set(labels.loc[labels["is_fraudulent"], "honesty_type"])
    assert offenders.issubset({"opportunistic", "systematic"})


def test_every_fraud_record_belongs_to_an_episode(generated) -> None:
    _, _, internal, _ = generated
    labels = internal.labels
    assert (labels.loc[labels["is_fraudulent"], "episode_id"] != "none").all()


def test_fraud_is_clustered_in_episodes_not_spread_row_by_row(generated) -> None:
    """If fraud were an independent per-row draw, episode days would not concentrate it."""
    _, _, internal, _ = generated
    labels = internal.labels
    overall = labels["is_fraudulent"].mean()
    episodes = labels[labels["episode_id"] != "none"]
    assert episodes["is_fraudulent"].mean() > 5 * overall


def test_episodes_mix_real_and_fraudulent_work(generated) -> None:
    _, _, internal, _ = generated
    labels = internal.labels
    episodes = labels[labels["episode_id"] != "none"]
    assert episodes["is_fraudulent"].any()
    assert (~episodes["is_fraudulent"]).any()


def test_typology_labels_are_valid(generated) -> None:
    _, _, internal, _ = generated
    labels = internal.labels
    fraud = labels.loc[labels["is_fraudulent"], "fraud_typology"]
    assert set(fraud).issubset(set(FRAUD_TYPOLOGIES))
    assert (labels.loc[~labels["is_fraudulent"], "fraud_typology"] == "none").all()


def test_all_four_typologies_are_represented(generated) -> None:
    _, _, internal, _ = generated
    labels = internal.labels
    present = set(labels.loc[labels["is_fraudulent"], "fraud_typology"])
    assert present == set(FRAUD_TYPOLOGIES)


def test_legitimate_modes_cover_dormant_and_trial_lapse(generated) -> None:
    _, _, internal, _ = generated
    modes = set(internal.labels.loc[~internal.labels["is_fraudulent"], "mode"])
    assert modes == set(LEGIT_MODES)


def test_careful_is_only_ever_set_on_fraud(generated) -> None:
    _, _, internal, _ = generated
    labels = internal.labels
    assert not labels.loc[~labels["is_fraudulent"], "careful"].any()


def test_hard_cases_exist_in_both_directions(generated) -> None:
    _, _, internal, _ = generated
    labels = internal.labels
    careful_fraud = labels["is_fraudulent"] & labels["careful"]
    honest_lookalikes = ~labels["is_fraudulent"] & labels["is_ambiguous"]
    assert careful_fraud.sum() > 0
    assert honest_lookalikes.sum() > 0


def test_every_lookalike_situation_occurs_in_legitimate_records(generated) -> None:
    """No fraud-like situation may belong exclusively to fraud."""
    _, _, internal, _ = generated
    legitimate = internal.labels[~internal.labels["is_fraudulent"]]
    for flag in FLAG_COLUMNS:
        assert legitimate[flag].sum() > 0, f"{flag} never occurs legitimately"
