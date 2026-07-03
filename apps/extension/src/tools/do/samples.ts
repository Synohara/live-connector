import { stat } from "node:fs/promises"
import path from "node:path"
import { BadRequestError, NotFoundError } from "@live-connector/error"

const AUDIO_EXTENSIONS = new Set([".wav", ".aif", ".aiff", ".mp3", ".flac", ".ogg", ".m4a", ".aac"])

export function isSupportedAudioPath(filePath: string): boolean {
    return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

export async function assertSampleFile(filePath: string): Promise<void> {
    assertSamplePath(filePath)
    try {
        const file_stat = await stat(filePath)
        if (!file_stat.isFile()) {
            throw new BadRequestError("audioFilePath is not a file")
        }
    } catch (error) {
        if (error instanceof BadRequestError) {
            throw error
        }
        if (typeof error === "object" && error !== null && "code" in error) {
            throw new NotFoundError(`audio file was not found: ${filePath}`, {
                hint: "Check the absolute path exists and is readable.",
            })
        }
        throw error
    }
}

export function assertSamplePath(filePath: string): void {
    if (!path.isAbsolute(filePath)) {
        throw new BadRequestError("audioFilePath must be an absolute path", {
            hint: "Pass an absolute path, e.g. /Users/name/Samples/kick.wav.",
        })
    }
    if (!isSupportedAudioPath(filePath)) {
        throw new BadRequestError(
            `unsupported audio format "${path.extname(filePath)}" for audioFilePath`,
            { hint: `Supported extensions: ${[...AUDIO_EXTENSIONS].join(", ")}.` },
        )
    }
}
