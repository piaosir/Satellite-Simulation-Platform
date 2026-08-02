// 频率计划工作台的「刻度」接线：模型内部一律 MHz，屏上一律工具栏那一个单位。
// 转发器表 / 检查器 / 批量条 / 批量生成（FreqPlanApp）与频率分配表（FpAlloc）共用这一份 ——
// 两处各写一遍必漂（一边把空串落成 null、另一边落成 0 这类分歧，正是「换个页签数就不一样」的由来）。
//
// 换单位只换刻度、不改任何物理量：14000 MHz 选到 kHz 就写成 14000000 kHz，那条转发器还在原处，
// 故换来换去无损，已建好的计划一并跟着换（存的从来只有 MHz 那一份）。
import { ref, computed, watch } from 'vue'
import { freqFromMHz, freqToMHz, unitLabel, fmtFreqU, fmtFreqNum } from '../shared/freqPlanModel.js'

/**
 * @param unitOf 取当前单位的函数（FreqPlanApp 给 opt.unit、FpAlloc 给 props.unit）
 *   U      当前单位名 —— 列头与标签写它，故是「上行中心 kHz」而不是恒写 MHz
 *   dispF  MHz → 输入框里的数（拿原数、不定小数位：定了会把正在敲的字改掉，见 fmtFreqNum）
 *   toM    输入框里的数 → MHz（落值一律经它；空串 → null，保「空 ≠ 0」）
 *   textF  写给人看的「数 + 单位」（title、回执、提示语）· numF 同上但不带单位（表格里的只读数）
 *   dval / dput / ddone  手输草稿，见下
 */
export function useFreqUnit(unitOf) {
  const U = computed(() => unitLabel(unitOf()))
  const dispF = (mhz) => { const v = freqFromMHz(mhz, unitOf()); return v == null ? '' : v }
  const toM = (v) => freqToMHz(v, unitOf())
  const textF = (mhz) => fmtFreqU(mhz, unitOf())
  const numF = (mhz) => (Number.isFinite(mhz) ? fmtFreqNum(mhz, unitOf()) : '—')

  // 手输草稿。★ 这些格子是「显示值 → 存 MHz → 换算回显」的回路，中间态会被回写改掉：GHz 档下
  //   把 14.022 改成 14.5，敲到「14.」时 num() 已给出 14、回显成「14」把那个点吞掉，下一个字符
  //   就落错位置（同 oneway-value-binding-wipes-input 那类坑；MHz 档下敲小数同样中招，只是换了
  //   刻度之后成了常态）。故录入期间显示原字、照常即时落值（图与表跟着走），离焦再回到规范读数。
  // 一次只可能有一格在敲，草稿因此只存一份 { 哪一格, 正在敲的字 }。
  const draft = ref({ k: '', v: '' })
  const dval = (k, mhz) => (draft.value.k === k ? draft.value.v : dispF(mhz))
  const dput = (k, raw, put) => { draft.value = { k, v: raw }; put(toM(raw)) }
  const ddone = () => { draft.value = { k: '', v: '' } }
  // 换刻度时丢掉没敲完的那半个数：它是上一把尺子上的
  watch(() => unitOf(), ddone)

  return { U, dispF, toM, textF, numF, dval, dput, ddone }
}

/**
 * 迟落草稿 —— 敲字期间只留字面、【不改模型】，回车或离焦（change）才落值。
 *
 * 与上面 dput 那一套的分别只在落值时机。频带那四个数（中心 · 带宽 · 起 · 止）互相约束，敲到一半的
 * 前缀在等式里同样成立：把 14022 改成 14100 的中途要经过 141，即时落值先拿 141 把整条转发器定死
 * （带宽跟着算成荒唐数），下一个字符又落在别的分支上；带宽格同理（36 → 72 的中途是 7）。94 波束的
 * 计划还要为每一个中间态重排一次整张图。故这四格一律迟落。
 *
 * ★ 草稿带上【开敲时是哪一条】：点表格另一行时 mousedown 先把 selectedId 改掉，本格的 change/blur
 *   在那之后才到 —— 不把当时那条抓下来，这几个字就落到刚点中的那一行上了。
 *
 *   lval  格子里显示什么（有草稿显示原字，否则按刻度回显模型值）
 *   lput  @input：只记草稿
 *   lend  @change：落值（apply 收到开敲时那条与换算好的 MHz）· @blur 也调它，没敲过就只是清草稿
 *   lclr  丢草稿（换条目 / 换刻度）
 */
export function useLateDraft(unitOf, dispF, toM) {
  const draft = ref({ k: '', v: '', ctx: null })
  const lval = (k, mhz) => {
    if (draft.value.k === k) return draft.value.v
    const v = dispF(mhz)
    return v == null ? '' : v
  }
  const lput = (k, ctx, raw) => { draft.value = { k, v: raw, ctx } }
  const lclr = () => { draft.value = { k: '', v: '', ctx: null } }
  const lend = (k, apply) => {
    const d = draft.value
    lclr()
    if (d.k === k) apply(d.ctx, toM(d.v), d.v)
  }
  watch(() => unitOf(), lclr)
  return { lval, lput, lend, lclr, draft }
}
