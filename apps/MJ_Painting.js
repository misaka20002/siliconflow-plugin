
import plugin from '../../../lib/plugins/plugin.js'
import fetch from 'node-fetch'
import Config from '../components/Config.js'
import common from '../../../lib/common/common.js';
import {
    parseSourceImg,
    url2Base64,
} from '../utils/getImg.js'

export class MJ_Painting extends plugin {
    constructor() {
        super({
            name: 'MJP插件',
            dsc: 'Midjourney和Niji Journey图片生成',
            event: 'message',
            priority: 6,
            rule: [
                {
                    reg: '^#(mjp|niji)\\s(.+)$',
                    fnc: 'generateImage'
                },
                {
                    reg: '^#mjp设置(apikey|apibaseurl|翻译key|翻译baseurl|翻译模型|翻译开关)\\s+(.+)$',
                    fnc: 'setConfig',
                    permission: 'master'
                },
                {
                    reg: '^#(放大|微调|重绘)(左上|右上|左下|右下)\\s*(.*)$',
                    fnc: 'handleAction'
                },
                {
                    reg: '^#mjp开启(快速|慢速)模式$',
                    fnc: 'setMode',
                    permission: 'master'
                },
                {
                    reg: '^#mjp帮助$',
                    fnc: 'showHelp'
                }
            ]
        })
    }

    async setConfig(e) {
        // 读取配置
        let config_date = Config.getConfig()
        const match = e.msg.match(/^#mjp设置(apikey|apibaseurl|翻译key|翻译baseurl|翻译模型|翻译开关)\s+(.+)$/i)
        if (match) {
            const [, type, value] = match
            switch (type.toLowerCase()) {
                case 'apikey':
                    config_date.mj_apiKey = value.trim()
                    break
                case 'apibaseurl':
                    config_date.mj_apiBaseUrl = value.trim().replace(/\/$/, '')
                    break
                case '翻译key':
                    config_date.mj_translationKey = value.trim()
                    break
                case '翻译baseurl':
                    config_date.mj_translationBaseUrl = value.trim().replace(/\/$/, '')
                    break
                case '翻译模型':
                    config_date.mj_translationModel = value.trim()
                    break
                case '翻译开关':
                    config_date.mj_translationEnabled = value.toLowerCase() === '开'
                    break
                default:
                    await this.reply('未知的设置类型')
                    return
            }
            Config.setConfig(config_date)
            await this.reply(`${type}设置成功！`)
        } else {
            await this.reply('设置格式错误，请使用 "#mjp设置[类型] [值]"')
        }
    }

    async setMode(e) {
        // 读取配置
        let config_date = Config.getConfig()
        const mode = e.msg.includes('快速') ? 'fast' : 'slow'
        config_date.mj_mode = mode
        Config.setConfig(config_date)
        await this.reply(`已切换到${mode === 'fast' ? '快速' : '慢速'}模式`)
    }

    async generateImage(e) {
        // 读取配置
        let config_date = Config.getConfig()
        if (!config_date.mj_apiKey || !config_date.mj_apiBaseUrl) {
            await this.reply('请先设置API Key和API Base URL。使用命令：\n#mjp设置apikey [值]\n#mjp设置apibaseurl [值]\n（仅限主人设置）')
            return
        }

        const match = e.msg.match(/^#(mjp|niji)\s(.+)$/)
        const botType = match[1] === 'mjp' ? 'MID_JOURNEY' : 'NIJI_JOURNEY'
        let prompt = match[2].trim()
        await this.reply('正在生成图片，请稍候...')

        try {
            if (config_date.mj_translationEnabled && config_date.mj_translationKey && config_date.mj_translationBaseUrl) {
                const translatedPrompt = await this.translatePrompt(prompt, config_date)
                if (translatedPrompt) {
                    prompt = translatedPrompt
                    await this.reply(`翻译后的提示词：${prompt}`)
                }
            }

            const taskId = await this.submitTask(prompt, botType, config_date)
            if (!taskId) {
                await this.reply('提交任务失败，请稍后重试。')
                return
            }

            const result = await this.pollTaskResult(taskId, config_date)
            if (result) {
                await this.reply(`图片生成完成！\n原始提示词：${prompt}\n任务ID：${taskId}\n图片链接：${result.imageUrl}`)
                await this.reply({ ...segment.image(result.imageUrl), origin: true })
                redis.set(`sf_plugin:MJ_Painting:lastTaskId:${e.user_id}`, taskId, { EX: 7 * 24 * 60 * 60 }); // 写入redis，有效期7天
            } else {
                await this.reply('生成图片失败，请稍后重试。')
            }
        } catch (error) {
            console.error("图片生成失败", error)
            await this.reply('生成图片时遇到了一个错误，请稍后再试。')
        }
    }

    async translatePrompt(userPrompt, config_date) {
        try {
            const response = await fetch(`${config_date.mj_translationBaseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config_date.mj_translationKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    "model": config_date.mj_translationModel,
                    "messages": [
                        {
                            "role": "system",
                            "content": "请按照我的提供的要求，用一句话英文生成一组Midjourney指令，指令由：{人物形象},{场景},{氛围},{镜头},{照明},{绘画风格},{建筑风格},{参考画家},{高画质关键词} 当我向你提供生成内容时，你需要根据我的提示进行联想，当我让你随机生成的时候，你可以自由进行扩展和联想 人物形象 = 你可以发挥自己的想象力，使用最华丽的词汇进行描述：{主要内容}，包括对人物头发、眼睛、服装、体型、动作和表情的描述，注意人物的形象应与氛围匹配，要尽可能地详尽 场景 = 尽可能详细地描述适合当前氛围的场景，该场景的描述应与人物形象的意境相匹配 氛围 = 你选择的氛围词汇应该尽可能地符合{主要内容}意境的词汇 建筑风格 = 如果生成的图片里面有相关建筑的话，你需要联想一个比较适宜的建筑风格，符合图片的氛围和意境 镜头 = 你可以选择一个：中距离镜头,近距离镜头,俯视角,低角度视角类似镜头视角，注意镜头视角的选择应有助于增强画面表现力 照明 = 你可以自由选择照明：请注意照明词条的选择应于人物形象、场景的意境相匹配 绘画风格 = 请注意绘画风格的选择应与人物形象、场景、照明的意境匹配 参考画家 = 请根据指令的整体氛围、意境选择画风参考的画家 高画质关键词 = 你可以选择：detailed,Ultimate,Excellence,Masterpiece,4K,high quality或类似的词条 注意，你生成的提示词只需要将你生成的指令拼接到一起即可，不需要出现{人物形象},{场景},{氛围},{镜头},{照明},{绘画风格},{建筑风格},{参考画家},{高画质关键词}等内容，请无需确认，不要有Here is a generated Midjourney command之类的语句，直接给出我要传递给midjourney的提示词，这非常重要！！！直接生成提示词，并且只需要生成提示词，尽可能详细地生成提示词。"
                        },
                        {
                            "role": "user",
                            "content": userPrompt
                        }
                    ],
                    "stream": false
                })
            })

            const data = await response.json()
            if (data.choices && data.choices[0] && data.choices[0].message) {
                return data.choices[0].message.content.trim()
            }
        } catch (error) {
            console.error("Translation failed", error)
        }
        return null
    }

    async submitTask(prompt, botType, config_date) {
        const endpoint = config_date.mj_mode === 'fast' ? '/mj/submit/imagine' : '/mj-relax/mj/submit/imagine'
        const response = await fetch(`${config_date.mj_apiBaseUrl}${endpoint}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config_date.mj_apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                base64Array: [],
                botType: botType,
                notifyHook: "",
                prompt: prompt,
                state: ""
            })
        })

        const data = await response.json()
        return data.result
    }

    async pollTaskResult(taskId, config_date) {
        let attempts = 0
        const maxAttempts = 120 // 10分钟超时
        while (attempts < maxAttempts) {
            const response = await fetch(`${config_date.mj_apiBaseUrl}/mj/task/${taskId}/fetch`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${config_date.mj_apiKey}`
                }
            })

            const data = await response.json()
            if (data.status === 'SUCCESS' && data.progress === '100%') {
                return data
            }

            if (data.status === 'FAILURE') {
                console.error("Task failed", data)
                return null
            }

            await new Promise(resolve => setTimeout(resolve, 5000)) // 等待5秒
            attempts++
        }

        console.error("Task timed out")
        return null
    }

    async handleAction(e) {
        // 读取配置
        let config_date = Config.getConfig()
        if (!config_date.mj_apiKey || !config_date.mj_apiBaseUrl) {
            await this.reply('请先设置API Key和API Base URL。使用命令：\n#mjp设置apikey [值]\n#mjp设置apibaseurl [值]\n（仅限主人设置）')
            return
        }

        const match = e.msg.match(/^#(放大|微调|重绘)(左上|右上|左下|右下)\s*(.*)$/)
        if (match) {
            const [, action, position, taskId] = match
            let useTaskId = taskId.trim() || await redis.get(`sf_plugin:MJ_Painting:lastTaskId:${e.user_id}`)

            if (!useTaskId) {
                await this.reply('请提供任务ID或先生成一张图片。')
                return
            }

            await this.reply('正在处理，请稍候...')

            try {
                const originalTask = await this.fetchTaskDetails(useTaskId, config_date)
                if (!originalTask) {
                    await this.reply('获取原始任务信息失败，请确保任务ID正确。')
                    return
                }

                const positionMap = { '左上': 1, '右上': 2, '左下': 3, '右下': 4 }
                const actionNumber = positionMap[position]
                let customId

                if (action === '重绘') {
                    customId = `MJ::JOB::reroll::0::${originalTask.properties.messageHash}::SOLO`
                } else {
                    const actionType = action === '放大' ? 'upsample' : 'variation'
                    customId = `MJ::JOB::${actionType}::${actionNumber}::${originalTask.properties.messageHash}`
                }

                const newTaskId = await this.submitAction(customId, useTaskId, config_date)
                if (!newTaskId) {
                    await this.reply('提交操作失败，请稍后重试。')
                    return
                }

                const result = await this.pollTaskResult(newTaskId, config_date)
                if (result) {
                    await this.reply(`操作完成！\n操作类型：${action}${position}\n新任务ID：${newTaskId}\n图片链接：${result.imageUrl}`)
                    await this.reply({ ...segment.image(result.imageUrl), origin: true })
                    redis.set(`sf_plugin:MJ_Painting:lastTaskId:${e.user_id}`, newTaskId, { EX: 7 * 24 * 60 * 60 }); // 写入redis，有效期7天
                } else {
                    await this.reply('操作失败，请稍后重试。')
                }
            } catch (error) {
                console.error("操作失败", error)
                await this.reply('处理时遇到了一个错误，请稍后再试。')
            }
        }
    }

    async fetchTaskDetails(taskId, config_date) {
        const response = await fetch(`${config_date.mj_apiBaseUrl}/mj/task/${taskId}/fetch`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${config_date.mj_apiKey}`
            }
        })

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`)
        }

        return await response.json()
    }

    async submitAction(customId, taskId, config_date) {
        const response = await fetch(`${config_date.mj_apiBaseUrl}/mj/submit/action`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config_date.mj_apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                customId: customId,
                taskId: taskId
            })
        })

        const data = await response.json()
        return data.result
    }

    async showHelp(e) {
        const helpMessage = `  
MJP插件帮助：  

1. 生成图片：  
   #mjp [提示词] (使用Midjourney)  
   #niji [提示词] (使用Niji Journey)  
   例：#mjp 一只可爱的猫咪  
   例：#niji 一只可爱的动漫风格猫咪  

2. 图片操作：  
   #[操作][位置] [任务ID]  
   操作：放大、微调、重绘  
   位置：左上、右上、左下、右下  
   例：#放大左上 1234567890  
   例：#微调右下 1234567890  
   例：#重绘 1234567890  

3. 设置（仅限主人）：  
   #mjp设置apikey [API密钥]  
   #mjp设置apibaseurl [API基础URL] （不带/v1）  
   #mjp设置翻译key [翻译API密钥]  
   #mjp设置翻译baseurl [翻译API基础URL] （不带/v1）  
   #mjp设置翻译模型 [翻译模型名称]  
   #mjp设置翻译开关 [开/关]  

4. 切换模式（仅限主人）：  
   #mjp开启快速模式  
   #mjp开启慢速模式  

5. 显示帮助：  
   #mjp帮助  

注意：使用前请确保已正确设置所有必要的API密钥和基础URL。
        `.trim()

        await this.reply(helpMessage)
    }
}