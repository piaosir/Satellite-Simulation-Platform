// 平台引导到微信小程序用的固定入口（帮助 → 微信小程序 介绍弹窗）。
//
// MINI_NAME：小程序在微信里的注册名，「搜一搜」按它搜；小程序码的来路见 MiniAboutDialog 头注。
//
// 反方向（小程序引导到平台）的安装包固定下载地址不在这里：平台自己不需要展示自己的下载地址
// （2026-09-10 用户定），地址只有两处 —— 发版脚本 scripts/publish-cos.mjs 的 STABLE_FILE（产出方）
// 与小程序 Satellitelinkbudget/miniprogram/utils/satsimApp.js 的 DOWNLOAD_URL（展示方），改要一起改。
export const MINI_NAME = 'LinkLab星链链路计算'
