import type { ServerDeps } from "../../deps"
import { appendUndoEntry } from "../../undo/log"
import type { InverseOperation, UndoLogEntry } from "../../undo/types"
import { confirmGate, nextWriteId, type UndoableLevel } from "../common"

const write_id_counter = { value: 0 }

export type WriteContext = {
    writeId: string
    statement: string
    kind: "set" | "create" | "delete" | "copy"
    summary: string
    undoable: UndoableLevel
    undoableReason?: string
    inverse: InverseOperation[]
}

export function beginWrite(
    statement: string,
    kind: WriteContext["kind"],
    summary: string,
    undoable: UndoableLevel,
    undoable_reason?: string,
): WriteContext {
    return {
        writeId: nextWriteId(write_id_counter),
        statement,
        kind,
        summary,
        undoable,
        ...(undoable_reason !== undefined ? { undoableReason: undoable_reason } : {}),
        inverse: [],
    }
}

export async function finalizeWrite(
    deps: ServerDeps,
    context: WriteContext,
): Promise<{ writeId: string; undoable: UndoableLevel; undoableReason?: string }> {
    const entry: UndoLogEntry = {
        writeId: context.writeId,
        time: new Date().toISOString(),
        statement: context.statement,
        kind: context.kind,
        summary: context.summary,
        undoable: context.undoable,
        ...(context.undoableReason !== undefined ? { undoableReason: context.undoableReason } : {}),
        status: "applied",
        inverse: context.inverse,
    }
    await appendUndoEntry(deps, entry)
    return {
        writeId: context.writeId,
        undoable: context.undoable,
        ...(context.undoableReason !== undefined ? { undoableReason: context.undoableReason } : {}),
    }
}

export function checkConfirm(
    undoable: UndoableLevel,
    undoable_reason: string | undefined,
    confirm: boolean | undefined,
    plan: Record<string, unknown>,
): Record<string, unknown> | null {
    return confirmGate(undoable, undoable_reason, confirm, plan)
}

export function noMatchResponse(hint: string): Record<string, unknown> {
    return { status: "no_match", matched: 0, hint }
}
