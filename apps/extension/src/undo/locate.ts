import { Chain, type ClipSlot, MidiClip, Track } from "@ableton-extensions/sdk"
import type { ServerDeps } from "../deps"
import type { LomGraphAdapter, LomNode } from "../lom/adapter"
import { createAdapterFromDeps } from "../lom/create-adapter"
import { objectIdentity } from "./identity"

const CLIP_LABELS = ["Clip", "MidiClip", "AudioClip"] as const
const TRACK_LABELS = ["Track", "MidiTrack", "AudioTrack"] as const
const DEVICE_LABELS = ["Device", "Simpler", "RackDevice", "DrumRack"] as const

function nodeMatchesIdentity(node: LomNode, identity: string): boolean {
    if (node.type === "object") {
        return objectIdentity(node.value) === identity
    }
    if (node.type === "note") {
        return objectIdentity(node.value) === identity
    }
    return false
}

async function expandAllDevices(adapter: LomGraphAdapter, track_node: LomNode): Promise<LomNode[]> {
    const devices = await adapter.expand(track_node, ["HAS_DEVICE"])
    const all: LomNode[] = [...devices]
    for (const device of devices) {
        const chains = await adapter.expand(device, ["HAS_CHAIN"])
        for (const chain of chains) {
            all.push(...(await adapter.expand(chain, ["HAS_DEVICE"])))
        }
    }
    return all
}

async function findInSeeds(
    adapter: LomGraphAdapter,
    labels: readonly string[],
    identity: string,
): Promise<LomNode | null> {
    for (const seed_label of labels) {
        const seeds = await adapter.seeds(seed_label)
        for (const seed of seeds) {
            if (nodeMatchesIdentity(seed, identity)) {
                return seed
            }
        }
    }
    return null
}

async function findNoteByIdentity(
    adapter: LomGraphAdapter,
    identity: string,
): Promise<LomNode | null> {
    const clips = await adapter.seeds("MidiClip")
    for (const clip_node of clips) {
        const notes = await adapter.expand(clip_node, ["HAS_NOTE"])
        for (const note of notes) {
            if (note.type === "note" && nodeMatchesIdentity(note, identity)) {
                return note
            }
        }
    }
    return null
}

async function findDeviceByIdentity(
    adapter: LomGraphAdapter,
    identity: string,
    include_parameters: boolean,
): Promise<LomNode | null> {
    const tracks = await adapter.seeds("Track")
    for (const track_node of tracks) {
        const devices = await expandAllDevices(adapter, track_node)
        for (const device_node of devices) {
            if (nodeMatchesIdentity(device_node, identity)) {
                return device_node
            }
            if (include_parameters) {
                const params = await adapter.expand(device_node, ["HAS_PARAM"])
                for (const param of params) {
                    if (param.type === "object" && nodeMatchesIdentity(param, identity)) {
                        return param
                    }
                }
            }
        }
    }
    return null
}

async function findClipByIdentity(
    adapter: LomGraphAdapter,
    identity: string,
): Promise<LomNode | null> {
    const direct = await findInSeeds(adapter, CLIP_LABELS, identity)
    if (direct !== null) {
        return direct
    }
    const tracks = await adapter.seeds("Track")
    for (const track_node of tracks) {
        if (track_node.type !== "object" || !(track_node.value instanceof Track)) {
            continue
        }
        const slots = await adapter.expand(track_node, ["HAS_CLIPSLOT"])
        for (const slot_node of slots) {
            const clips = await adapter.expand(slot_node, ["HAS_CLIP"])
            for (const clip_node of clips) {
                if (nodeMatchesIdentity(clip_node, identity)) {
                    return clip_node
                }
            }
        }
    }
    return null
}

export async function findTrackByIdentity(
    deps: ServerDeps,
    track_identity: string,
): Promise<Track<import("../deps").TargetApiVersion> | null> {
    const adapter = createAdapterFromDeps(deps)
    const node = await findInSeeds(adapter, TRACK_LABELS, track_identity)
    if (node === null || node.type !== "object" || !(node.value instanceof Track)) {
        return null
    }
    return node.value
}

export async function findClipSlotByTrackAndIndex(
    deps: ServerDeps,
    track_identity: string,
    slot_index: number,
): Promise<ClipSlot<import("../deps").TargetApiVersion> | null> {
    const track = await findTrackByIdentity(deps, track_identity)
    if (track === null) {
        return null
    }
    const slot = track.clipSlots[slot_index]
    if (slot === undefined) {
        return null
    }
    return slot
}

export async function findMidiClipByIdentity(
    deps: ServerDeps,
    clip_identity: string,
): Promise<MidiClip<import("../deps").TargetApiVersion> | null> {
    const adapter = createAdapterFromDeps(deps)
    const node = await findClipByIdentity(adapter, clip_identity)
    if (node === null || node.type !== "object" || !(node.value instanceof MidiClip)) {
        return null
    }
    return node.value
}

export async function findDeviceParentByIdentity(
    deps: ServerDeps,
    parent_identity: string,
): Promise<
    Track<import("../deps").TargetApiVersion> | Chain<import("../deps").TargetApiVersion> | null
> {
    const adapter = createAdapterFromDeps(deps)
    const track = await findInSeeds(adapter, TRACK_LABELS, parent_identity)
    if (track !== null && track.type === "object" && track.value instanceof Track) {
        return track.value
    }
    const chains = await adapter.seeds("Chain")
    for (const chain_node of chains) {
        if (chain_node.type === "object" && chain_node.value instanceof Chain) {
            if (objectIdentity(chain_node.value) === parent_identity) {
                return chain_node.value
            }
        }
    }
    const tracks = await adapter.seeds("Track")
    for (const track_node of tracks) {
        const devices = await expandAllDevices(adapter, track_node)
        for (const device_node of devices) {
            const nested_chains = await adapter.expand(device_node, ["HAS_CHAIN"])
            for (const chain_node of nested_chains) {
                if (
                    chain_node.type === "object" &&
                    chain_node.value instanceof Chain &&
                    objectIdentity(chain_node.value) === parent_identity
                ) {
                    return chain_node.value
                }
            }
        }
    }
    return null
}

export async function findNodeByIdentity(
    deps: ServerDeps,
    identity: string,
    label: string,
    adapter?: LomGraphAdapter,
): Promise<LomNode | null> {
    const graph = adapter ?? createAdapterFromDeps(deps)

    if (label === "Note") {
        return findNoteByIdentity(graph, identity)
    }
    if (label === "Parameter") {
        return findDeviceByIdentity(graph, identity, true)
    }
    if (DEVICE_LABELS.includes(label as (typeof DEVICE_LABELS)[number])) {
        return findDeviceByIdentity(graph, identity, false)
    }
    if (CLIP_LABELS.includes(label as (typeof CLIP_LABELS)[number])) {
        return findClipByIdentity(graph, identity)
    }
    if (label === "ClipSlot") {
        return null
    }

    const direct = await findInSeeds(graph, [label], identity)
    if (direct !== null) {
        return direct
    }

    if (label === "Track") {
        return findInSeeds(graph, TRACK_LABELS, identity)
    }

    return null
}
