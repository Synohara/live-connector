/**
 * companion と拡張の同一 Set 判定に使う epoch。
 * SDK handle と Live Python の handle は別物なので比較できない。
 * 代わりに通常トラック名の並びを同一アルゴリズム（djb2）でハッシュして比較する。
 * companion（Python）側は同じアルゴリズムを実装する。
 */

export function trackNameEpoch(track_names: string[]): string {
    const joined = track_names.join("|")
    let hash = 5381
    for (let index = 0; index < joined.length; index++) {
        hash = ((hash << 5) + hash + joined.charCodeAt(index)) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
}
