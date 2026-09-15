import type { HybridError } from "@live-connector/error"
import { afterEach, describe, expect, it } from "vitest"
import type { MainRenderArgs } from "../types/hybrid"
import {
    clearRenderPlansForTest,
    createRenderPlan,
    mainRenderArgHash,
    verifyRenderPlan,
} from "./plan"

const args: MainRenderArgs = {
    startTime: 0,
    endTime: 64,
    preRollBeats: 0,
    keepCaptureTrack: false,
}

afterEach(() => {
    clearRenderPlansForTest()
})

describe("render plan", () => {
    it("hashes arguments independently of key order", () => {
        expect(mainRenderArgHash(args)).toBe(mainRenderArgHash({ ...args }))
        expect(mainRenderArgHash(args)).not.toBe(mainRenderArgHash({ ...args, endTime: 32 }))
    })

    it("verifies a plan with the same Set identity and arguments", () => {
        const plan = createRenderPlan({ setId: "set-a", args })
        const verified = verifyRenderPlan({ planId: plan.planId, setId: "set-a", args })
        expect(verified.planId).toBe(plan.planId)
    })

    it("rejects a plan from a different Set", () => {
        const plan = createRenderPlan({ setId: "set-a", args })
        expect(() => verifyRenderPlan({ planId: plan.planId, setId: "set-b", args })).toThrow(
            /Live Set changed/,
        )
    })

    it("rejects changed arguments as PLAN_STALE", () => {
        const plan = createRenderPlan({ setId: "set-a", args })
        try {
            verifyRenderPlan({ planId: plan.planId, setId: "set-a", args: { ...args, endTime: 8 } })
            throw new Error("expected a throw")
        } catch (error) {
            expect((error as HybridError).code).toBe("PLAN_STALE")
        }
    })

    it("rejects an expired plan", () => {
        const plan = createRenderPlan({ setId: "set-a", args, ttlMs: 1 })
        const future = Date.parse(plan.expiresAt) + 10
        try {
            verifyRenderPlan({ planId: plan.planId, setId: "set-a", args, now: future })
            throw new Error("expected a throw")
        } catch (error) {
            expect((error as HybridError).code).toBe("PLAN_STALE")
        }
    })

    it("rejects an unknown plan", () => {
        expect(() => verifyRenderPlan({ planId: "plan-nope", setId: "set-a", args })).toThrow(
            /not found/,
        )
    })
})
