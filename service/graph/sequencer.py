"""Animation and timeline sequencing for Threat Graph frontend visualization."""
from __future__ import annotations

from typing import Sequence

from .models import AnimationStep, GraphEdge, GraphNode, TimelineStep


class AnimationSequencer:
    """Builds chronological timeline and frontend playback animation steps."""

    @staticmethod
    def build_sequencing(
        nodes: Sequence[GraphNode],
        edges: Sequence[GraphEdge],
        title: str,
        risk_level: str,
    ) -> tuple[list[TimelineStep], list[AnimationStep]]:
        node_map = {n.id: n for n in nodes}

        # Sort edges by timestamp if available
        sorted_edges = sorted(
            edges,
            key=lambda e: (e.timestamp is None, e.timestamp),
        )

        timeline_steps: list[TimelineStep] = []
        animation_steps: list[AnimationStep] = []

        step_idx = 1
        processed_nodes: set[str] = set()
        processed_edges: set[str] = set()

        # Phase 1: Reveal root/actor nodes (e.g. customer/user/actor)
        actor_nodes = [n for n in nodes if n.node_group == "actor" or n.type in ("customer", "threat_actor")]
        if not actor_nodes and nodes:
            actor_nodes = [nodes[0]]

        if actor_nodes:
            actor_ids = [n.id for n in actor_nodes]
            for n_id in actor_ids:
                processed_nodes.add(n_id)

            animation_steps.append(
                AnimationStep(
                    step=step_idx,
                    action="REVEAL_NODE",
                    node_ids=actor_ids,
                    edge_ids=[],
                    message=f"Step {step_idx}: Identified initial entity ({actor_nodes[0].label})",
                )
            )
            step_idx += 1

        # Phase 2: Process edges in temporal/logical sequence
        for edge in sorted_edges:
            new_nodes: list[str] = []
            if edge.source_id not in processed_nodes:
                new_nodes.append(edge.source_id)
                processed_nodes.add(edge.source_id)
            if edge.target_id not in processed_nodes:
                new_nodes.append(edge.target_id)
                processed_nodes.add(edge.target_id)

            processed_edges.add(edge.id)

            # Build timeline step
            ts = edge.timestamp
            src_node = node_map.get(edge.source_id)
            tgt_node = node_map.get(edge.target_id)
            src_label = src_node.label if src_node else edge.source_id
            tgt_label = tgt_node.label if tgt_node else edge.target_id

            if ts:
                timeline_steps.append(
                    TimelineStep(
                        step_index=len(timeline_steps) + 1,
                        timestamp=ts,
                        title=edge.label,
                        description=f"{src_label} {edge.relation_type.lower().replace('_', ' ')} {tgt_label}: {edge.reason}",
                        related_nodes=[edge.source_id, edge.target_id],
                        related_edges=[edge.id],
                    )
                )

            animation_steps.append(
                AnimationStep(
                    step=step_idx,
                    action="REVEAL_NODE_AND_EDGE",
                    node_ids=new_nodes,
                    edge_ids=[edge.id],
                    message=f"Step {step_idx}: {edge.label} - {edge.reason}",
                )
            )
            step_idx += 1

        # Add remaining unprocessed orphan nodes if any
        orphan_nodes = [n.id for n in nodes if n.id not in processed_nodes]
        if orphan_nodes:
            animation_steps.append(
                AnimationStep(
                    step=step_idx,
                    action="REVEAL_NODE",
                    node_ids=orphan_nodes,
                    edge_ids=[],
                    message=f"Step {step_idx}: Revealed contextual environment nodes",
                )
            )
            step_idx += 1

        # Phase 3: Highlight critical suspicious attack chain
        suspicious_edges = [e.id for e in edges if e.is_suspicious or e.is_highlighted]
        suspicious_nodes = [n.id for n in nodes if n.is_critical or n.is_highlighted]

        if suspicious_edges or suspicious_nodes:
            animation_steps.append(
                AnimationStep(
                    step=step_idx,
                    action="HIGHLIGHT_ATTACK_CHAIN",
                    node_ids=suspicious_nodes,
                    edge_ids=suspicious_edges,
                    message=f"Step {step_idx}: Highlighting key attack path and verdict ({risk_level.upper()} Risk)",
                )
            )

        return timeline_steps, animation_steps
