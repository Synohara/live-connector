import { Chain, Clip, type Device, Track } from "@ableton-extensions/sdk"
import { BadRequestError } from "@live-connector/error"
import type { TargetApiVersion } from "../../deps"
import type { LomNode } from "../../lom/adapter"
import { type ToolResult, textResult } from "../common"

type V = TargetApiVersion

export function guardDestructive(
    summary: Record<string, unknown>,
    preview: boolean | undefined,
    confirm: boolean | undefined,
): ToolResult | null {
    if (preview === true) {
        return textResult({ status: "preview", ...summary })
    }
    if (confirm !== true) {
        return textResult({
            status: "confirm_required",
            ...summary,
            hint: "This is a destructive operation. Pass confirm:true to proceed.",
        })
    }
    return null
}

export function trackSummary(
    track: Track<V>,
    song: { tracks: Track<V>[] },
): Record<string, unknown> {
    const index = song.tracks.findIndex((candidate) => candidate.handle === track.handle)
    return { name: track.name, index: index < 0 ? null : index }
}

export function requireRegularTrack(node: LomNode, song: { tracks: Track<V>[] }): Track<V> {
    if (node.type !== "object" || !(node.value instanceof Track)) {
        throw new BadRequestError("MATCH must return a Track")
    }
    const track = node.value
    const is_regular = song.tracks.some((candidate) => candidate.handle === track.handle)
    if (!is_regular) {
        throw new BadRequestError(
            "only regular MidiTrack / AudioTrack in song.tracks can be deleted or copied",
            { hint: "Return / main tracks cannot be deleted or copied." },
        )
    }
    return track
}

export function deviceParent(device: Device<V>): Track<V> | Chain<V> {
    const parent = device.parent
    if (parent instanceof Track || parent instanceof Chain) {
        return parent
    }
    throw new BadRequestError("the selected Device has no Track or Chain parent", {
        hint: "Select a device reached via HAS_DEVICE from a Track or a rack Chain.",
    })
}

export function isArrangementClip(node: LomNode): boolean {
    if (node.type !== "object" || !(node.value instanceof Track)) {
        return false
    }
    return node.value.arrangementClips.some(
        (clip) => clip.handle === (node.value as { handle?: unknown }).handle,
    )
}

export function resolveArrangementParent(
    clip_node: LomNode,
): { clip: Clip<V>; track: Track<V> } | null {
    if (clip_node.type !== "object") {
        return null
    }
    const clip = clip_node.value
    if (!(clip instanceof Clip)) {
        return null
    }
    const parent = clip.parent
    if (!(parent instanceof Track)) {
        return null
    }
    if (!parent.arrangementClips.some((candidate) => candidate.handle === clip.handle)) {
        return null
    }
    return { clip, track: parent }
}
