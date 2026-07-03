import { z } from "zod"

export const SET_PROPERTY_SCHEMAS = {
    Song: z.object({ tempo: z.number().positive().optional() }),
    Track: z.object({
        name: z.string().optional(),
        arm: z.boolean().optional(),
        mute: z.boolean().optional(),
        solo: z.boolean().optional(),
    }),
    Clip: z.object({
        name: z.string().optional(),
        color: z.number().optional(),
        muted: z.boolean().optional(),
        looping: z.boolean().optional(),
        warping: z.boolean().optional(),
        warpMode: z
            .enum(["Beats", "Tones", "Texture", "Repitch", "Complex", "ComplexPro"])
            .optional(),
        startTime: z.number().min(0).optional(),
        duration: z.number().positive().optional(),
        startMarker: z.number().min(0).optional(),
        endMarker: z.number().positive().optional(),
    }),
    Scene: z.object({ name: z.string().optional() }),
    CuePoint: z.object({ name: z.string().optional() }),
    Parameter: z.object({ value: z.number() }),
    Simpler: z.object({ sampleFile: z.string().min(1) }),
    MidiClip: z.object({
        notes: z
            .array(
                z.object({
                    pitch: z.number().int().min(0).max(127),
                    startTime: z.number().min(0),
                    duration: z.number().positive(),
                    velocity: z.number().min(0).max(127).optional(),
                    muted: z.boolean().optional(),
                    probability: z.number().min(0).max(1).optional(),
                    releaseVelocity: z.number().min(0).max(127).optional(),
                    velocityDeviation: z.number().optional(),
                }),
            )
            .optional(),
    }),
    Note: z.object({
        pitch: z.number().int().min(0).max(127).optional(),
        startTime: z.number().min(0).optional(),
        duration: z.number().positive().optional(),
        velocity: z.number().min(0).max(127).optional(),
        muted: z.boolean().optional(),
        probability: z.number().min(0).max(1).optional(),
        releaseVelocity: z.number().min(0).max(127).optional(),
        velocityDeviation: z.number().optional(),
    }),
} as const

export const WRITABLE_BY_LABEL: Record<string, string[]> = {
    Song: ["tempo"],
    Track: ["name", "arm", "mute", "solo"],
    MidiTrack: ["name", "arm", "mute", "solo"],
    AudioTrack: ["name", "arm", "mute", "solo"],
    ReturnTrack: ["name", "arm", "mute", "solo"],
    MainTrack: ["name", "arm", "mute", "solo"],
    Clip: [
        "name",
        "color",
        "muted",
        "looping",
        "startTime",
        "duration",
        "startMarker",
        "endMarker",
    ],
    MidiClip: [
        "name",
        "color",
        "muted",
        "looping",
        "startTime",
        "duration",
        "startMarker",
        "endMarker",
        "notes",
    ],
    AudioClip: [
        "name",
        "color",
        "muted",
        "looping",
        "warping",
        "warpMode",
        "startTime",
        "duration",
        "startMarker",
        "endMarker",
    ],
    Scene: ["name"],
    CuePoint: ["name"],
    Parameter: ["value"],
    Simpler: ["sampleFile"],
    Note: [
        "pitch",
        "startTime",
        "duration",
        "velocity",
        "muted",
        "probability",
        "releaseVelocity",
        "velocityDeviation",
    ],
}

export function writablePropertiesHint(): string {
    return Object.entries(WRITABLE_BY_LABEL)
        .map(([label, props]) => `${label}: ${props.join(", ")}`)
        .join("; ")
}
