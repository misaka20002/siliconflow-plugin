import _ from 'lodash'
import {
    getAtUserIds,
    getUserDetailedInfo
} from './onebotUtils.js'

/**
 * 应用预设到文本中
 * @param {string} text - 原始输入文本
 * @param {object} config - 配置对象,包含 presets 数组
 * @param {object} e 消息事件，需要 e.sender，At 昵称替换还会使用 e.message 和 e.group
 * @returns {Promise<object>} 返回对象包含:
 *   - processedText: 处理后的文本(预设名替换为预设文本)
 *   - usedPresets: 使用过的预设数组 [{name, prompt}]
 *   - originalText: 处理后的文本(预设名替换为占位符： {sf预设: ${presetName}} )
 *   - images: 命中的预设所配置的图片链接数组（已合并去重，保留预设顺序）
 *   - blocked: 是否因「仅主人可用」被拦截（非主人误触发）
 *   - blockedPresets: 被拦截的预设名数组
 */
export async function applyPresets(text, config, e = {}) {
    const originalTextInput = text || '';
    const emptyResult = {
        processedText: text || '',
        usedPresets: [],
        originalText: originalTextInput,
        images: [],
        blocked: false,
        blockedPresets: []
    }
    if (!text || typeof text !== 'string') {
        return emptyResult
    }

    const presets = config?.presets || []
    if (!Array.isArray(presets) || presets.length === 0) {
        return {
            processedText: text,
            usedPresets: [],
            originalText: originalTextInput,
            images: [],
            blocked: false,
            blockedPresets: []
        }
    }

    const isMaster = !!e?.isMaster

    // 按预设名长度降序排序,优先匹配较长的预设名
    // 同时保留 isOnlyMaster，用于非主人拦截
    const sortedPresets = [...presets]
        .filter(p => p.name && p.prompt)
        .map(p => {
            const nameTrimmed = p.name.trim();
            const regexStr = config.antiMisoperation
                ? `\\{预设:${escapeRegExp(nameTrimmed)}\\}`
                : escapeRegExp(nameTrimmed);
            return {
                name: nameTrimmed,
                prompt: p.prompt.trim(),
                isOnlyMaster: !!p.isOnlyMaster,
                images: normalizeImages(p.images),
                regex: new RegExp(regexStr, 'gi')
            };
        })
        .sort((a, b) => b.name.length - a.name.length)

    // 收集所有匹配项并按位置排序
    const allMatches = []
    for (const preset of sortedPresets) {
        let match
        preset.regex.lastIndex = 0
        while ((match = preset.regex.exec(text)) !== null) {
            allMatches.push({
                start: match.index,
                end: match.index + match[0].length,
                preset
            })
        }
    }

    // 按起始位置排序，位置相同时长的优先
    allMatches.sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start
        return (b.end - b.start) - (a.end - a.start)
    })

    // 过滤掉重叠的匹配，只保留不重叠的
    const validMatches = []
    let lastEnd = -1
    for (const match of allMatches) {
        if (match.start >= lastEnd) {
            validMatches.push(match)
            lastEnd = match.end
        }
    }

    // 非主人命中「仅主人可用」预设：提示并拦截，不继续替换
    if (!isMaster) {
        const blockedNames = []
        const blockedNameSet = new Set()
        for (const match of validMatches) {
            if (match.preset.isOnlyMaster && !blockedNameSet.has(match.preset.name)) {
                blockedNameSet.add(match.preset.name)
                blockedNames.push(match.preset.name)
            }
        }
        if (blockedNames.length > 0) {
            const names = blockedNames.join('、')
            const tip = blockedNames.length === 1
                ? `预设「${names}」仅主人可用`
                : `以下预设仅主人可用：${names}`
            try {
                if (typeof e?.reply === 'function') {
                    await e.reply(tip, true)
                }
            } catch (err) {
                logger?.error?.('[sf插件] 预设仅主人可用提示失败:', err)
            }
            return {
                processedText: text,
                usedPresets: [],
                originalText: originalTextInput,
                images: [],
                blocked: true,
                blockedPresets: blockedNames
            }
        }
    }

    // 从后向前替换，避免位置偏移问题
    validMatches.reverse()

    let processedText = text
    let originalText = text
    const usedPresets = []
    const usedPresetNames = new Set()
    const images = []
    const imageSet = new Set()

    for (const match of validMatches) {
        const { start, end, preset } = match

        // 记录使用的预设
        if (!usedPresetNames.has(preset.name)) {
            usedPresetNames.add(preset.name)
            usedPresets.push({
                name: preset.name,
                prompt: preset.prompt
            })
        }

        // 收集该预设配置的图片（合并去重，保留预设顺序）
        if (Array.isArray(preset.images)) {
            for (const img of preset.images) {
                if (!img || imageSet.has(img)) continue
                imageSet.add(img)
                images.push(img)
            }
        }

        // 替换 processedText
        processedText = processedText.slice(0, start) + preset.prompt + processedText.slice(end)

        // 替换 originalText
        originalText = originalText.slice(0, start) + `{sf预设: ${preset.name}}` + originalText.slice(end)
    }

    // 应用设定拓展
    processedText = await replacePromptForSenderMsg(e, processedText);

    return {
        processedText: processedText.trim(),
        usedPresets,
        originalText,
        images,
        blocked: false,
        blockedPresets: []
    }
}

/**
 * 转义正则表达式特殊字符
 * @param {string} string - 需要转义的字符串
 * @returns {string} 转义后的字符串
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 规范化预设图片字段：支持字符串（逗号/换行分隔）与数组两种形式，
 * 统一返回去空白、去空的字符串数组。
 * @param {*} images 预设的图片配置
 * @returns {string[]}
 */
function normalizeImages(images) {
    if (!images) return []
    let list = images
    if (typeof images === 'string') {
        list = images.split(/[,\n，]/)
    }
    if (!Array.isArray(list)) return []
    return list
        .map(v => (typeof v === 'string' ? v.trim() : ''))
        .filter(v => v)
}

/**
 * 将预设命中返回的图片链接合并进 e.img，供下游图生图流程统一下载/转码。
 * 支持 http(s)://、base64://、data:、file:// 及本地绝对路径（由 url2Base64 统一处理）。
 * 合并后统一受 maxCollectedImages 截断。
 * @param {object} e 消息事件对象，图片收集后 e.img 为数组
 * @param {string[]} images 预设图片链接数组
 * @param {number} maxCollectedImages 最大收集图片数
 * @returns {void}
 */
export function mergePresetImages(e, images, maxCollectedImages) {
    if (!Array.isArray(images) || images.length === 0) return
    const limit = Number.isFinite(Number(maxCollectedImages))
        ? Math.max(1, Math.floor(Number(maxCollectedImages)))
        : Infinity

    if (!e.img) {
        e.img = []
    } else if (!Array.isArray(e.img)) {
        e.img = [e.img]
    }

    for (const img of images) {
        if (e.img.length >= limit) break
        if (typeof img !== 'string' || !img) continue
        if (e.img.includes(img)) continue
        e.img.push(img)
    }
}

/**
 * 生成预设使用说明
 * @param {Array} usedPresets - 使用过的预设数组
 * @returns {string} 预设使用说明文本
 */
export function generatePresetInfo(usedPresets) {
    if (!Array.isArray(usedPresets) || usedPresets.length === 0) {
        return ''
    }

    const presetNames = usedPresets.map(p => p.name).join('、')
    return `\n使用预设：${presetNames}`
}

/** 在 prompt 中替换发送者、被 At 用户及时间信息 */
async function replacePromptForSenderMsg(e, systemMsg = "") {
    const getCurrentDate = () => {
        const date = new Date();
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };
    const getCurrentTime = () => {
        const date = new Date();
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    };
    const sender = e?.sender || {}
    const atUserNames = /_at\d+_name_/i.test(systemMsg)
        ? await Promise.all(getAtUserIds(e).map(async userId => {
            const userInfo = await getUserDetailedInfo(e, userId)
            return userInfo?.card || userInfo?.name || ''
        }))
        : []

    // _sender_name_ 始终表示当前发送者，被 At 用户通过 _atN_name_ 按顺序获取
    systemMsg = systemMsg.replace(/_sender_name_/igm, () => sender.card || sender.nickname || '')
    systemMsg = systemMsg.replace(/_at(\d+)_name_/igm, (_, index) => atUserNames[Number(index) - 1] || '')
    systemMsg = systemMsg.replace(/_sender_id_/igm, sender.user_id ?? '')
    systemMsg = systemMsg.replace(/_sender_gender_/igm, sender.sex ?? '')
    systemMsg = systemMsg.replace(/_sender_age_/igm, sender.age ?? '')
    systemMsg = systemMsg.replace(/_sender_area_/igm, sender.area ?? '')
    systemMsg = systemMsg.replace(/_sender_role_/igm, `${sender.role == "owner" ? '群主' : `${sender.role == "admin" ? '管理员' : ''}`}`)
    systemMsg = systemMsg.replace(/_sender_title_/igm, sender.title ?? '')
    systemMsg = systemMsg.replace(/_date_/igm, getCurrentDate())
    systemMsg = systemMsg.replace(/_time_/igm, getCurrentTime())
    systemMsg = systemMsg.replace(/_sender_groupid_/igm, e?.group_id || sender.user_id || '')
    return systemMsg;
}
