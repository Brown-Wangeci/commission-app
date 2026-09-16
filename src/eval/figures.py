"""Publication figures for the write-up.

Usage: python -m src.eval.figures

Everything is drawn in greyscale with direct labels, so the figures survive
being printed in black and white and do not depend on colour to be read.
Captions are written to a separate text file so they can be pasted into the
document rather than retyped from the images.

The constants below are presentation settings (figure size, resolution, font
size), not model parameters.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from ..generator import config as config_module

OUTPUT_DIR = config_module.REPO_ROOT / "outputs"
FIGURE_DIR = OUTPUT_DIR / "figures" / "publication"
DPI = 300
INK = "#111111"
MID = "#666666"
LIGHT = "#cccccc"
PALE = "#eeeeee"
GRID = "#dddddd"


def apply_style() -> None:
    matplotlib.rcParams.update({
        "figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white",
        "axes.edgecolor": MID, "axes.labelcolor": INK, "axes.titlecolor": INK,
        "xtick.color": INK, "ytick.color": INK, "text.color": INK,
        "axes.grid": True, "grid.color": GRID, "grid.linewidth": 0.6, "grid.linestyle": "-",
        "axes.spines.top": False, "axes.spines.right": False, "axes.axisbelow": True,
        "font.size": 10, "axes.titlesize": 11, "legend.frameon": False,
        "figure.dpi": 110, "savefig.dpi": DPI, "savefig.bbox": "tight",
    })


def read(name: str) -> pd.DataFrame:
    return pd.read_csv(OUTPUT_DIR / f"{name}.csv")


def cost_surface_figure() -> str:
    surface = read("band_cost_surface")
    operating = read("band_operating_point")
    point = operating.iloc[0]
    cost = surface.pivot_table(index="reject_threshold", columns="release_threshold", values="expected_cost")
    review = surface.pivot_table(index="reject_threshold", columns="release_threshold", values="review_share")

    colours = plt.get_cmap("Greys").copy()
    colours.set_bad("#c9c9c9")  # distinct from the near-white low-cost region
    fig, axis = plt.subplots(figsize=(7.2, 5.6))
    mesh = axis.pcolormesh(cost.columns, cost.index, np.ma.masked_invalid(cost.to_numpy()),
                           shading="nearest", cmap=colours)
    bar = fig.colorbar(mesh, ax=axis)
    bar.set_label("Expected cost per activation (commissions)")
    bar.outline.set_edgecolor(MID)

    capacity = float(point["capacity_share"])
    contour = axis.contour(review.columns, review.index, review.to_numpy(), levels=[capacity],
                           colors=[INK], linewidths=1.6, linestyles="dashed")
    axis.clabel(contour, fmt={capacity: "review capacity"}, fontsize=8)
    axis.scatter([point["release_threshold"]], [point["reject_threshold"]], s=190, marker="*",
                 facecolor="white", edgecolor=INK, linewidth=1.4, zorder=5)
    axis.annotate(
        f"chosen point\nrelease {point['release_threshold']:.2f}, reject {point['reject_threshold']:.2f}",
        xy=(point["release_threshold"], point["reject_threshold"]),
        xycoords="data", xytext=(0.60, 0.30), textcoords="axes fraction",
        fontsize=9, ha="left", arrowprops={"arrowstyle": "-", "color": INK, "linewidth": 0.9},
    )
    axis.text(0.60, 0.13, "release above reject:\nnot a valid policy", transform=axis.transAxes,
              fontsize=8, color=INK)
    axis.set(xscale="log", yscale="log",
             xlabel="Auto-release threshold (calibrated probability)",
             ylabel="Reject threshold (calibrated probability)")
    axis.grid(visible=False)
    path = FIGURE_DIR / "f1_cost_surface.png"
    fig.savefig(path)
    plt.close(fig)
    return path.name


def commission_figure() -> str:
    scan = read("commission_sweep_scan").sort_values("commission_value_kes")
    headline = read("commission_sweep")
    collapse = read("commission_collapse_point").iloc[0]
    assumed = float(collapse["current_assumed_commission_value_kes"])

    fig, axes = plt.subplots(1, 2, figsize=(11.5, 4.4))
    bands = [("released_share", "auto-released", PALE, None),
             ("review_share", "review", MID, "///"),
             ("reject_share", "reject", INK, None)]
    bottom = np.zeros(len(scan))
    for column, label, colour, hatch in bands:
        axes[0].fill_between(scan["commission_value_kes"], bottom, bottom + scan[column],
                             facecolor=colour, edgecolor=INK, linewidth=0.5, hatch=hatch, label=label)
        bottom = bottom + scan[column].to_numpy()
    axes[0].axvline(assumed, color=INK, linestyle="dotted", linewidth=1.2)
    axes[0].text(assumed * 1.05, 0.45, f"assumed\nKSh {assumed:.0f}", fontsize=8)
    axes[0].set(xlabel="Commission value (KSh)", ylabel="Share of activations", ylim=(0, 1),
                xlim=(scan["commission_value_kes"].min(), scan["commission_value_kes"].max()),
                title="Band shares against commission value")
    axes[0].legend(fontsize=8, loc="center right")

    axes[1].plot(scan["commission_value_kes"], scan["review_share"], color=INK, marker="",
                 linewidth=1.6)
    axes[1].scatter(headline["commission_value_kes"], headline["review_share"], s=42,
                    facecolor="white", edgecolor=INK, zorder=5)
    for _, row in headline.iterrows():
        axes[1].annotate(f"{row['review_share']:.1%}",
                         xy=(row["commission_value_kes"], row["review_share"]),
                         xytext=(0, 7), textcoords="offset points", fontsize=8, ha="center")
    axes[1].axvline(assumed, color=INK, linestyle="dotted", linewidth=1.2)
    edge = float(collapse["collapses_below_kes"])
    axes[1].axvspan(scan["commission_value_kes"].min(), edge, facecolor=LIGHT, alpha=0.6)
    axes[1].text(scan["commission_value_kes"].min() * 1.05, axes[1].get_ylim()[1] * 0.55,
                 f"no review band\nbelow KSh {edge:.0f}", fontsize=8)
    axes[1].set(xlabel="Commission value (KSh)", ylabel="Share sent to review",
                title="The middle band exists only above a commission value")
    path = FIGURE_DIR / "f2_commission_value.png"
    fig.savefig(path)
    plt.close(fig)
    return path.name


def tornado_figure() -> str:
    sensitivity = read("band_sensitivity")
    baseline = sensitivity[sensitivity["scenario"] == "baseline"].iloc[0]
    singles = sensitivity[sensitivity["scenario"].str.contains(r"\blow\b|\bhigh\b", regex=True)]
    singles = singles[~singles["scenario"].str.startswith("all-")]
    singles = singles.assign(
        parameter=singles["scenario"].str.replace(r" (low|high) .*", "", regex=True),
        end=np.where(singles["scenario"].str.contains(" low "), "low", "high"),
    )

    # One ordering for both panels. With a shared y axis the second set_yticks
    # call wins, so per-panel orderings would label one panel with the other's
    # rows. Rank by the largest movement a parameter causes in either threshold.
    swing = singles.groupby("parameter")[["release_shift", "reject_shift"]].apply(
        lambda block: block.abs().to_numpy().max()
    )
    order = list(swing.sort_values().index)
    positions = np.arange(len(order))

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), sharey=True)
    for axis, column, title in zip(
        axes, ["release_shift", "reject_shift"],
        ["Auto-release threshold", "Reject threshold"],
    ):
        for end, colour, hatch in (("low", LIGHT, None), ("high", MID, "///")):
            values = (
                singles[singles["end"] == end].set_index("parameter")[column].reindex(order).fillna(0.0)
            )
            offset = 0.19 if end == "low" else -0.19
            axis.barh(positions + offset, values, height=0.34, facecolor=colour, edgecolor=INK,
                      linewidth=0.6, hatch=hatch, label=f"{end} end of range")
        axis.axvline(0, color=INK, linewidth=1)
        axis.set(xlabel="Shift in threshold from baseline", title=title)
        axis.grid(axis="y", visible=False)
    axes[0].set_yticks(positions, [name.replace("_", " ") for name in order])
    axes[1].legend(fontsize=8, loc="lower right")
    fig.suptitle(
        f"Baseline thresholds: release {baseline['release_threshold']:.2f}, "
        f"reject {baseline['reject_threshold']:.2f}", fontsize=10,
    )
    path = FIGURE_DIR / "f3_sensitivity_tornado.png"
    fig.savefig(path)
    plt.close(fig)
    return path.name


def _table_axis(axis: plt.Axes, frame: pd.DataFrame, title: str, row_height: float = 0.075) -> None:
    """Draw a frame as a table, anchored to the top and sized to its own rows."""
    axis.axis("off")
    axis.set_title(title, fontsize=10, loc="left")
    height = row_height * (len(frame) + 1)
    table = axis.table(cellText=frame.to_numpy(), colLabels=list(frame.columns),
                       cellLoc="right", bbox=[0.0, 1.0 - height, 1.0, height])
    table.auto_set_font_size(False)
    table.set_fontsize(8.5)
    for (row, _), cell in table.get_celld().items():
        cell.set_edgecolor(MID)
        cell.set_linewidth(0.5)
        if row == 0:
            cell.set_facecolor(LIGHT)
            cell.set_text_props(weight="bold")
        elif row % 2 == 0:
            cell.set_facecolor(PALE)


def fairness_figure() -> str:
    honesty = read("comparison_fairness_by_honesty")
    situation = read("comparison_fairness_held_totals")
    situation = situation[situation["population"] == "honest agents only"]

    honesty_table = honesty.pivot_table(index="honesty_type", columns="band",
                                        values=["share_mean_phase5", "share_mean_phase6"])
    order = ["honest", "opportunistic", "systematic"]
    rows = []
    for agent_type in order:
        rows.append([
            agent_type,
            f"{honesty_table.loc[agent_type, ('share_mean_phase6', 'review')]:.2%}",
            f"{honesty_table.loc[agent_type, ('share_mean_phase5', 'reject')]:.2%}",
            f"{honesty_table.loc[agent_type, ('share_mean_phase6', 'reject')]:.2%}",
        ])
    honesty_frame = pd.DataFrame(rows, columns=["agent type", "review (now)", "refused (was)", "refused (now)"])

    situation_rows = [
        [row["situation"].replace("_", " "), f"{row['share_mean_phase5']:.2%}", f"{row['share_mean_phase6']:.2%}"]
        for _, row in situation.iterrows()
    ]
    situation_frame = pd.DataFrame(situation_rows, columns=["situation", "held (was)", "held (now)"])

    fig, axes = plt.subplots(1, 2, figsize=(11.5, 3.4), gridspec_kw={"width_ratios": [1.0, 1.0]})
    _table_axis(axes[0], honesty_frame, "Genuine activations by agent type", row_height=0.20)
    _table_axis(axes[1], situation_frame, "Honest agents: genuine work held, by situation", row_height=0.075)
    path = FIGURE_DIR / "f4_fairness_tables.png"
    fig.savefig(path)
    plt.close(fig)
    return path.name


def auto_release_figure() -> str:
    summary = read("auto_release_summary")
    target = summary[summary["released_precision_target"] == 0.99]
    labels = {"t7_none": "T7 (seven-day hold)", "t0_none": "T0 (submission only)"}
    order = ["t7_none", "t0_none"]
    indexed = target.set_index("model").reindex(order)

    fig, axis = plt.subplots(figsize=(8.2, 3.8))
    positions = np.arange(len(order))[::-1]
    for offset, column, colour, hatch, label in (
        (0.19, "auto_released_share_mean", PALE, None, "auto-released"),
        (-0.19, "review_queue_share_mean", MID, "///", "sent to review"),
    ):
        axis.barh(positions + offset, indexed[column], height=0.34, facecolor=colour,
                  edgecolor=INK, linewidth=0.7, hatch=hatch, label=label)
        for y, value in zip(positions + offset, indexed[column]):
            axis.text(value + 0.012, y, f"{value:.1%}", va="center", fontsize=9)
    axis.set_yticks(positions, [labels[name] for name in order])
    axis.set(xlim=(0, 1.0), xlabel="Share of all activations",
             title="Auto-release at a 99% genuine released set")
    axis.grid(axis="y", visible=False)
    axis.legend(fontsize=9, loc="lower right")
    path = FIGURE_DIR / "f5_auto_release.png"
    fig.savefig(path)
    plt.close(fig)
    return path.name


def captions() -> Dict[str, str]:
    point = read("band_operating_point").iloc[0]
    collapse = read("commission_collapse_point").iloc[0]
    gap = read("auto_release_t0_vs_t7")
    gap99 = gap[gap["released_precision_target"] == 0.99].iloc[0]
    honesty = read("comparison_fairness_by_honesty")
    reject = honesty[honesty["band"] == "reject"].set_index("honesty_type")
    return {
        "f1_cost_surface.png":
            "Expected cost per activation in commissions, over every pair of auto-release and reject "
            "thresholds on the calibrated fraud probability, averaged across seeds 7, 42, 101 and 2024. "
            "Darker is more expensive; the pale triangle is the region where the release threshold would "
            "exceed the reject threshold, which is not a valid policy. The dashed line marks the review "
            f"capacity of one reviewer ({float(point['capacity_share']):.1%} of daily volume); the "
            "constraint does not bind, so the constrained and unconstrained optima coincide at the "
            f"starred point (release {float(point['release_threshold']):.2f}, reject "
            f"{float(point['reject_threshold']):.2f}).",
        "f2_commission_value.png":
            "Band structure against the shilling value of one commission, the least-sourced input in the "
            "cost matrix. Left: share of activations in each band as the commission value varies, with the "
            "assumed value marked. Right: the review band alone, with the five values re-optimised in the "
            f"sweep labelled. The middle band is empty at or below KSh "
            f"{float(collapse['highest_value_with_no_review_band_kes']):.0f} and opens from KSh "
            f"{float(collapse['collapses_below_kes']):.0f} upward, so the three-band design depends on a "
            "commission being worth more than roughly that much.",
        "f3_sensitivity_tornado.png":
            "Movement of each threshold when one cost parameter is moved to each end of its stated range, "
            "holding the others at baseline. Bars are the shift from the baseline threshold. The cost of "
            "refusing a genuine activation moves the reject threshold furthest; the cost of releasing a "
            "fraudulent one moves the release threshold furthest; review capacity moves neither, because "
            "the capacity constraint never binds.",
        "f4_fairness_tables.png":
            "Genuine activations only, at the chosen operating point, averaged across four seeds. Left: the "
            "share of each agent type's honest work sent to review or refused outright, before and after "
            "the corrected cost model. Right: honest agents' genuine work held in either band, by the "
            "legitimate working pattern the activation carries. Splitting the false positive by band cut "
            f"outright refusals by about three quarters for every agent type (honest "
            f"{float(reject.loc['honest', 'share_mean_phase5']):.2%} to "
            f"{float(reject.loc['honest', 'share_mean_phase6']):.2%}), while leaving the gap between "
            "agent types roughly unchanged.",
        "f5_auto_release.png":
            "Share of all activations that can be released without a human while keeping the released set "
            "99% genuine, for the model using only features available at submission (T0) and the model "
            "using the seven-day downstream window (T7), averaged across four seeds. The hold window "
            f"raises auto-release volume from {float(gap99['t0_auto_released_share']):.1%} to "
            f"{float(gap99['t7_auto_released_share']):.1%}, a gain of "
            f"{float(gap99['difference']) * 100:.1f} percentage points, and correspondingly shrinks the "
            "review queue.",
    }


def main() -> None:
    apply_style()
    FIGURE_DIR.mkdir(parents=True, exist_ok=True)
    built: List[str] = [
        cost_surface_figure(), commission_figure(), tornado_figure(),
        fairness_figure(), auto_release_figure(),
    ]
    text = captions()
    lines = ["# Figure captions", "",
             "Generated by src/eval/figures.py. Every number is a mean across seeds 7, 42, 101 and 2024.",
             ""]
    for name in built:
        lines.extend([f"## {name}", "", text[name], ""])
    (FIGURE_DIR / "captions.md").write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {len(built)} figures and captions to {FIGURE_DIR}")
    for name in built:
        print(f"  {name}")


if __name__ == "__main__":
    main()
