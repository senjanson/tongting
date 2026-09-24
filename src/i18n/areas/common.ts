/**
 * 通用文案（多个页面共用）：基础按钮、共享组件（src/ui/components、src/ui/shared）、
 * 界面状态派生（src/ui/state、src/ui/format.ts）。每个区域文件只由一处维护，en 必须与 zh-CN 键完全一致。
 */
const zhCN = {
  'common.localePreference.auto': '跟随浏览器',
  'common.localePreference.zh-CN': '中文',
  'common.localePreference.en': 'English',
  'common.localePreference.label': '界面语言',

  // 基础
  'common.cancel': '取消',
  'common.save': '保存',
  'common.copy': '复制',
  'common.close': '关闭',
  'common.retry': '重试',
  'common.search': '搜索',
  'common.settings': '设置',
  'common.unknown': '未知',
  'common.openSettings': '打开设置',
  'common.errorWithDetail': '{prefix}：{detail}',
  'common.listSeparator': ' · ',
  'common.openSettingsFailed': '无法打开设置页。',
  'common.openWorkspaceFailed': '无法打开字幕工作台。',
  'common.reloadTabFailed': '无法刷新标签页，请手动刷新。',
  'common.stateChanged': '状态已变化，已刷新。',
  'common.settingsNotPersisted': '仅本次生效，保存失败。设置将在浏览器重启后丢失。',
  'common.settingsFailed': '设置未生效：{detail}',

  // 品牌与通用布局
  'common.brand.name': '同听',
  'common.brand.note': 'TONGTING',
  'common.demo.label': '演示模式 · 示例数据，不连接视频与服务',
  'common.demo.aria': '演示模式',
  'common.demo.exit': '退出演示',
  'common.reconnect.stale': '正在重新连接后台服务，下方显示的可能不是最新状态。',
  'common.reconnect.connecting': '正在连接后台服务…',
  'common.toast.dismiss': '关闭提示',
  'common.errorBoundary.title': '界面出现错误',
  'common.errorBoundary.reload': '重新加载此页面',
  'common.errorBoundary.body':
    '正在进行的翻译不受影响（由后台管理）。重新加载后会从后台重新读取真实状态。',

  // 格式化
  'common.language.und': '未知语言',
  'common.language.auto': '自动识别',
  'common.language.withCode': '{name}（{code}）',
  'common.time.unknown': '未知时间',
  'common.latency.seconds': '{value} 秒',
  'common.latency.ms': '{value} 毫秒',
  'common.capability.verified': '已验证',
  'common.capability.failed': '失败',
  'common.capability.unsupported': '不支持',
  'common.capability.unchecked': '未检测',

  // 与后台通信
  'common.client.notConnected': '正在连接后台服务，请稍后重试。',
  'common.client.disconnected': '与后台的连接中断，操作结果未知。请查看当前状态后再决定是否重试。',
  'common.client.timeout':
    '后台在 {seconds} 秒内没有响应，操作结果未知。请查看当前状态后再决定是否重试。',
  'common.client.invalidResult': '后台返回了无法识别的结果，请更新扩展或重新加载后重试。',
  'common.client.invalidCommand': '输入的值不在允许范围内，请检查后重试。',
  'common.client.failed': '操作失败，请重试。',

  // 地址校验
  'common.url.wildcardHost': '服务地址的主机名不能包含 *。',
  'common.url.localAsrOnly':
    '本地识别服务地址只允许 http://127.0.0.1:<端口>，例如 http://127.0.0.1:8765。',

  // 服务配置
  'common.config.invalidUrl': '服务地址无效：{detail}',
  'common.config.missingBoth': '尚未配置 sub2api 服务地址与API Key，请先在设置中填写。',
  'common.config.missingUrl': '尚未配置 sub2api 服务地址，请先在设置中填写。',
  'common.config.missingKey': '尚未配置 sub2api API Key，请先在设置中填写。',
  'common.config.missingPermission':
    '尚未授予扩展访问服务地址的权限，请在设置中点击「授予访问权限」。',

  // 状态胶囊
  'common.status.error': '出错',
  'common.status.startBlocked': '启动受阻',
  'common.status.starting': '启动中',
  'common.status.translationBlocked': '翻译受阻',
  'common.status.buffering': '缓冲中',
  'common.status.bufferBlocked': '缓冲受阻',
  'common.status.preloadUnavailable': '无法预读',
  'common.status.running': '运行中',
  'common.status.pausing': '正在暂停',
  'common.status.pausedWithError': '已暂停 · 有错误',
  'common.status.paused': '翻译已暂停',
  'common.status.stopping': '正在停止',
  'common.status.reconnecting': '正在重新连接',
  'common.status.connecting': '正在连接',
  'common.status.invalidUrl': '地址无效',
  'common.status.notConfigured': '未配置服务',
  'common.status.readingTab': '读取标签页',
  'common.status.wakingPage': '正在连接页面',
  'common.status.ready': '可开始',
  'common.status.notVideo': '非视频页',

  // 主按钮
  'common.primary.notConnected': '正在连接后台服务，请稍候。',
  'common.primary.restart': '重新开始翻译',
  'common.primary.start': '开始翻译',
  'common.primary.stopping': '正在停止…',
  'common.primary.stoppingReason': '正在停止并释放资源。',
  'common.primary.resume': '继续翻译',
  'common.primary.pause': '暂停翻译',

  // 错误的下一步
  'common.nextStep.captureGesture':
    '音频采集需要新的用户操作：请点击浏览器工具栏中的同听图标，或按 Alt+T 后再继续。',
  'common.nextStep.checkSettings': '检查设置',
  'common.nextStep.configureAsr': '配置语音识别',
  'common.nextStep.checkTts': '检查配音设置',
  'common.nextStep.reloadYoutube': '刷新 YouTube 页面',
  'common.nextStep.retryLater': '稍后重试',
  'common.problem.blocked': '翻译受阻',
  'common.problem.error': '翻译出错',
  'common.problem.cannotResume': '无法继续翻译',
  'common.problem.startBlocked': '启动受阻',

  // 播放器状态
  'common.player.none': '未获取到播放器状态',
  'common.player.ad': '广告播放中',
  'common.player.ended': '视频已结束',
  'common.player.seeking': '正在跳转',
  'common.player.buffering': '缓冲中',
  'common.player.paused': '视频已暂停',
  'common.player.playing': '视频播放中',

  // 字幕来源与源语言
  'common.sourceMode.fullTrack': '完整字幕轨道',
  'common.sourceMode.incremental': '增量字幕',
  'common.sourceMode.asr': '语音识别',
  'common.sourceMode.asrPreload': '音频预读',
  'common.sourceMode.none': '暂无来源',
  'common.source.track': '字幕轨道 {label}（{code}）',
  'common.source.detected': '检测为{name}',
  'common.source.notDetected': '尚未检测',

  // 配音可用性与声音选择
  'common.voice.ttsNone': '语音合成设置为「不使用」，当前仅字幕。',
  'common.voice.sub2apiUnavailable': 'sub2api 语音合成不可用，当前仅字幕。',
  'common.voice.sub2apiUnavailableDetail': 'sub2api 语音合成不可用：{detail}，当前仅字幕。',
  'common.voice.sub2apiNoModel': '尚未填写 sub2api 语音合成模型，当前仅字幕。',
  'common.voice.sub2apiUnverified':
    'sub2api 语音合成尚未实测；可在设置页勾选「允许实际调用」后检查。仍可选择配音，调用失败时会提示并降级为仅字幕。',
  'common.voice.loading': '正在读取系统声音列表…',
  'common.voice.loadFailed': '无法读取系统声音列表：{detail}',
  'common.voice.noVoice':
    '系统没有可用的「{language}」声音，配音不可用，当前仅字幕。可在设置中改用 sub2api 语音合成。',
  'common.voice.mandarin': '普通话',
  'common.voice.mandarinTaiwan': '国语（台湾）',
  'common.voice.remote': '联网声音',
  'common.voice.local': '本机声音',
  'common.voice.system': '系统声音',
  'common.voice.groupTitle': 'VOICE / 配音声音',
  'common.voice.refresh': '刷新声音',
  'common.voice.auto': '自动选择（优先本机声音）',
  'common.voice.unavailableName': '{name}（暂不可用）',
  'common.voice.demoPreview': '演示模式不会播放声音。',
  'common.voice.previewFailed': '试听失败：{detail}',
  'common.voice.stopFailed': '停止试听失败：{detail}',
  'common.voice.label': '配音声音',
  'common.voice.count': '{count} 个可用声音 · 选择会自动保存到本机',
  'common.voice.fallbackCurrent': '原声音暂不可用，自动使用：',
  'common.voice.current': '当前使用：',
  'common.voice.preview': '试听',
  'common.voice.stopPreview': '停止试听',
  'common.voice.dubbingActive': '配音进行中。请先暂停翻译，再试听其他声音。',
  'common.voice.browseAll': '浏览并试听全部 {count} 个声音',
  'common.voice.listAria': '可用配音声音',
  'common.voice.use': '使用 {name}',
  'common.voice.previewNamed': '试听 {name}',
  'common.voice.selected': '已选用',
  'common.voice.previewHint': '试听不会改变选择；点击声音名称可选用。',
  'common.voice.quotaHint':
    '系统配音不消耗 sub2api 额度；字幕翻译仍使用模型额度。联网声音需要网络。',
  'common.voice.onlyOne': '当前浏览器只提供一个适用于目标语言的声音，可在系统中添加。',
  'common.voice.noneForTarget': '当前浏览器未提供适用于目标语言的声音，可在系统中添加。',
  'common.voice.howTo': '如何添加更多声音？',
  'common.voice.howToMac':
    'Mac：系统设置 → 辅助功能 → 阅读与朗读（旧版为“朗读内容”）→ 系统声音 → 管理声音，下载目标语言的声音。',
  'common.voice.howToRefresh':
    '安装完成后点击“刷新声音”。若仍未出现，请重新打开 Chrome。可用声音取决于系统和浏览器，部分系统音色可能不会提供给扩展。',
  'common.voice.appleLink': '查看 Apple 声音设置说明 ↗',

  // 模型选择
  'common.model.demoBlocked': '演示模式不连接真实服务，可手动填写示例模型。',
  'common.model.needCredentials': '先保存服务地址与 API Key，再获取模型列表。',
  'common.model.needPermission': '先授予服务地址访问权限，再获取模型列表。',
  'common.model.recommended': '{model} · 字幕翻译推荐',
  'common.model.manualCurrent': '手动输入（当前设置）',
  'common.model.choose': '— 选择模型 —',
  'common.model.label': '翻译模型',
  'common.model.hintFound':
    '服务返回 {total} 个模型，显示 {shown} 个 GPT 5.6 及以上文本候选。选择后仍需检查连接验证调用。',
  'common.model.hintDefault': '仅列出服务返回的 GPT 5.6 及以上文本模型；也可手动填写模型 ID。',
  'common.model.refresh': '刷新模型列表',
  'common.model.fetch': '获取模型列表',
  'common.model.discoveryFailed': '模型发现失败：{detail} 可重试或手动填写模型 ID。',
  'common.model.noneFound': '服务未返回 GPT 5.6 及以上文本模型，请确认账号权限或手动填写模型 ID。',
  'common.model.idLabel': '模型 ID（可手动填写）',

  // 主机权限
  'common.permission.grant': '授予访问权限',
  'common.permission.requestUnavailable': '无法申请访问权限，请在扩展详情页手动授予。',
  'common.permission.syncFailed': '权限状态同步失败：{detail}',
  'common.permission.granted': '已授予访问 {origin} 的权限。',
  'common.permission.denied': '未授予访问权限，扩展无法向该地址发送请求。',
  'common.permission.requestFailed': '申请访问权限失败，请检查地址后重试。',
  'common.permission.demoDisabled': '演示模式下不可用',
  'common.permission.requestTitle': '申请访问 {pattern}',

  // 播放方式
  'common.playback.mode': '播放方式',
  'common.playback.buffered': '同步优先',
  'common.playback.continuous': '连续播放',
  'common.playback.buffer': '翻译缓冲',
  'common.playback.seconds': '{count} 秒',
  'common.playback.secondsRecommended': '{count} 秒（推荐）',
  'common.playback.bufferedHint': '先缓冲译文再播放，后台持续预读；翻译跟不上时会暂停等待。',
  'common.playback.ready': '翻译缓冲就绪',
  'common.playback.preparing': '正在缓冲翻译',
  'common.playback.unavailable': '当前视频无法预读',
  'common.playback.blocked': '翻译缓冲受阻',
  'common.playback.switchContinuous': '切换连续播放',
  'common.playback.progress': '已准备 {ready} 秒 / 目标 {target} 秒',
  'common.playback.progressAria': '翻译缓冲进度',
  'common.playback.blockedHint': '可切换连续播放，再点击视频继续；译文和配音可能晚于画面。',
  'common.playback.systemVoiceHint': '系统配音在字幕时间到达时朗读，缓冲进度表示已准备的译文。',
  'common.playback.continuousHint': '视频连续播放，边播边译；字幕和配音可能晚于画面。',
} as const;

const en: Record<keyof typeof zhCN, string> = {
  'common.localePreference.auto': 'Follow browser',
  'common.localePreference.zh-CN': '中文',
  'common.localePreference.en': 'English',
  'common.localePreference.label': 'Interface language',

  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.copy': 'Copy',
  'common.close': 'Close',
  'common.retry': 'Retry',
  'common.search': 'Search',
  'common.settings': 'Settings',
  'common.unknown': 'Unknown',
  'common.openSettings': 'Open settings',
  'common.errorWithDetail': '{prefix}: {detail}',
  'common.listSeparator': ' · ',
  'common.openSettingsFailed': "Couldn't open Settings.",
  'common.openWorkspaceFailed': "Couldn't open the subtitle workspace.",
  'common.reloadTabFailed': "Couldn't reload the tab. Please reload it manually.",
  'common.stateChanged': 'The state changed and has been refreshed.',
  'common.settingsNotPersisted':
    'Applied for now, but not saved. This setting will be lost when the browser restarts.',
  'common.settingsFailed': 'Setting not applied: {detail}',

  'common.brand.name': 'Tongting',
  'common.brand.note': 'LIVE TRANSLATION',
  'common.demo.label': 'Demo mode · Sample data, no video or service connected',
  'common.demo.aria': 'Demo mode',
  'common.demo.exit': 'Exit demo',
  'common.reconnect.stale':
    'Reconnecting to the background service. What you see below may be out of date.',
  'common.reconnect.connecting': 'Connecting to the background service…',
  'common.toast.dismiss': 'Dismiss',
  'common.errorBoundary.title': 'Something went wrong',
  'common.errorBoundary.reload': 'Reload this page',
  'common.errorBoundary.body':
    'Translation in progress is not affected (it runs in the background). Reloading reads the current state again.',

  'common.language.und': 'Unknown language',
  'common.language.auto': 'Auto-detect',
  'common.language.withCode': '{name} ({code})',
  'common.time.unknown': 'Unknown time',
  'common.latency.seconds': '{value} s',
  'common.latency.ms': '{value} ms',
  'common.capability.verified': 'Verified',
  'common.capability.failed': 'Failed',
  'common.capability.unsupported': 'Unsupported',
  'common.capability.unchecked': 'Not checked',

  'common.client.notConnected':
    'Still connecting to the background service. Please try again shortly.',
  'common.client.disconnected':
    'Lost connection to the background service, so the result is unknown. Check the current state before retrying.',
  'common.client.timeout':
    'The background service did not respond within {seconds} s, so the result is unknown. Check the current state before retrying.',
  'common.client.invalidResult':
    'The background service returned an unrecognized result. Update or reload the extension and try again.',
  'common.client.invalidCommand': 'A value is outside the allowed range. Check it and try again.',
  'common.client.failed': 'Something went wrong. Please try again.',

  'common.url.wildcardHost': 'The service host name cannot contain *.',
  'common.url.localAsrOnly':
    'The local recognition service must be http://127.0.0.1:<port>, e.g. http://127.0.0.1:8765.',

  'common.config.invalidUrl': 'Invalid service URL: {detail}',
  'common.config.missingBoth':
    'The sub2api service URL and API key are not set. Add them in Settings first.',
  'common.config.missingUrl': 'The sub2api service URL is not set. Add it in Settings first.',
  'common.config.missingKey': 'The sub2api API key is not set. Add it in Settings first.',
  'common.config.missingPermission':
    "The extension can't access the service URL yet. Click “Grant access” in Settings.",

  'common.status.error': 'Error',
  'common.status.startBlocked': 'Start blocked',
  'common.status.starting': 'Starting',
  'common.status.translationBlocked': 'Blocked',
  'common.status.buffering': 'Buffering',
  'common.status.bufferBlocked': 'Buffer stalled',
  'common.status.preloadUnavailable': 'No read-ahead',
  'common.status.running': 'Running',
  'common.status.pausing': 'Pausing',
  'common.status.pausedWithError': 'Paused · Error',
  'common.status.paused': 'Paused',
  'common.status.stopping': 'Stopping',
  'common.status.reconnecting': 'Reconnecting',
  'common.status.connecting': 'Connecting',
  'common.status.invalidUrl': 'Invalid URL',
  'common.status.notConfigured': 'Not set up',
  'common.status.readingTab': 'Reading tab',
  'common.status.wakingPage': 'Connecting',
  'common.status.ready': 'Ready',
  'common.status.notVideo': 'No video',

  'common.primary.notConnected': 'Connecting to the background service…',
  'common.primary.restart': 'Restart translation',
  'common.primary.start': 'Start translation',
  'common.primary.stopping': 'Stopping…',
  'common.primary.stoppingReason': 'Stopping and releasing resources.',
  'common.primary.resume': 'Resume translation',
  'common.primary.pause': 'Pause translation',

  'common.nextStep.captureGesture':
    'Audio capture needs a new user action: click the Tongting icon in the browser toolbar or press Alt+T, then continue.',
  'common.nextStep.checkSettings': 'Check settings',
  'common.nextStep.configureAsr': 'Set up speech recognition',
  'common.nextStep.checkTts': 'Check voice settings',
  'common.nextStep.reloadYoutube': 'Reload YouTube page',
  'common.nextStep.retryLater': 'Retry later',
  'common.problem.blocked': 'Translation blocked',
  'common.problem.error': 'Translation error',
  'common.problem.cannotResume': "Can't resume translation",
  'common.problem.startBlocked': 'Start blocked',

  'common.player.none': 'Player status unavailable',
  'common.player.ad': 'Ad playing',
  'common.player.ended': 'Video ended',
  'common.player.seeking': 'Seeking',
  'common.player.buffering': 'Buffering',
  'common.player.paused': 'Video paused',
  'common.player.playing': 'Video playing',

  'common.sourceMode.fullTrack': 'Full caption track',
  'common.sourceMode.incremental': 'Live captions',
  'common.sourceMode.asr': 'Speech recognition',
  'common.sourceMode.asrPreload': 'Audio read-ahead',
  'common.sourceMode.none': 'No source yet',
  'common.source.track': 'Caption track {label} ({code})',
  'common.source.detected': 'detected as {name}',
  'common.source.notDetected': 'Not detected yet',

  'common.voice.ttsNone': 'Speech synthesis is set to “None”, so only subtitles are shown.',
  'common.voice.sub2apiUnavailable':
    'sub2api speech synthesis is unavailable, so only subtitles are shown.',
  'common.voice.sub2apiUnavailableDetail':
    'sub2api speech synthesis is unavailable: {detail}. Only subtitles are shown.',
  'common.voice.sub2apiNoModel':
    'No sub2api speech synthesis model is set, so only subtitles are shown.',
  'common.voice.sub2apiUnverified':
    'sub2api speech synthesis has not been tested. Enable “Allow real calls” in Settings to check it. You can still choose voice-over; if a call fails, you will be told and it falls back to subtitles only.',
  'common.voice.loading': 'Loading system voices…',
  'common.voice.loadFailed': "Couldn't load system voices: {detail}",
  'common.voice.noVoice':
    'No system voice is available for {language}, so voice-over is off and only subtitles are shown. You can switch to sub2api speech synthesis in Settings.',
  'common.voice.mandarin': 'Mandarin',
  'common.voice.mandarinTaiwan': 'Mandarin (Taiwan)',
  'common.voice.remote': 'Online voice',
  'common.voice.local': 'On-device voice',
  'common.voice.system': 'System voice',
  'common.voice.groupTitle': 'VOICE',
  'common.voice.refresh': 'Refresh voices',
  'common.voice.auto': 'Automatic (prefer on-device voices)',
  'common.voice.unavailableName': '{name} (unavailable)',
  'common.voice.demoPreview': 'Demo mode does not play audio.',
  'common.voice.previewFailed': 'Preview failed: {detail}',
  'common.voice.stopFailed': "Couldn't stop the preview: {detail}",
  'common.voice.label': 'Voice',
  'common.voice.count': '{count} voices available · Your choice is saved on this device',
  'common.voice.fallbackCurrent': 'Selected voice unavailable, using: ',
  'common.voice.current': 'Using: ',
  'common.voice.preview': 'Preview',
  'common.voice.stopPreview': 'Stop preview',
  'common.voice.dubbingActive':
    'Voice-over is playing. Pause translation before previewing other voices.',
  'common.voice.browseAll': 'Browse and preview all {count} voices',
  'common.voice.listAria': 'Available voices',
  'common.voice.use': 'Use {name}',
  'common.voice.previewNamed': 'Preview {name}',
  'common.voice.selected': 'Selected',
  'common.voice.previewHint':
    "Previewing doesn't change your choice. Click a voice name to select it.",
  'common.voice.quotaHint':
    "System voices don't use sub2api quota; subtitle translation still uses model quota. Online voices need a network connection.",
  'common.voice.onlyOne':
    'This browser offers only one voice for the target language. You can add more in your system settings.',
  'common.voice.noneForTarget':
    'This browser offers no voice for the target language. You can add one in your system settings.',
  'common.voice.howTo': 'How do I add more voices?',
  'common.voice.howToMac':
    'Mac: System Settings → Accessibility → Read & Speak (formerly “Spoken Content”) → System Voice → Manage Voices, then download voices for the target language.',
  'common.voice.howToRefresh':
    'After installing, click “Refresh voices”. If they still don’t appear, reopen Chrome. Available voices depend on your system and browser; some system voices may not be exposed to extensions.',
  'common.voice.appleLink': 'Apple’s guide to voice settings ↗',

  'common.model.demoBlocked':
    "Demo mode doesn't connect to a real service. You can type a sample model.",
  'common.model.needCredentials': 'Save the service URL and API key before loading models.',
  'common.model.needPermission': 'Grant access to the service URL before loading models.',
  'common.model.recommended': '{model} · Recommended for subtitles',
  'common.model.manualCurrent': 'Custom (current setting)',
  'common.model.choose': '— Choose a model —',
  'common.model.label': 'Translation model',
  'common.model.hintFound':
    'The service returned {total} models; showing {shown} GPT 5.6+ text models. Check the connection after choosing to verify calls.',
  'common.model.hintDefault':
    'Only GPT 5.6+ text models from the service are listed. You can also enter a model ID.',
  'common.model.refresh': 'Refresh models',
  'common.model.fetch': 'Load models',
  'common.model.discoveryFailed':
    "Couldn't load models: {detail} Retry or enter a model ID manually.",
  'common.model.noneFound':
    'The service returned no GPT 5.6+ text models. Check your account access or enter a model ID.',
  'common.model.idLabel': 'Model ID (editable)',

  'common.permission.grant': 'Grant access',
  'common.permission.requestUnavailable':
    "Can't request access. Grant it manually on the extension's details page.",
  'common.permission.syncFailed': "Couldn't sync the permission status: {detail}",
  'common.permission.granted': 'Access to {origin} granted.',
  'common.permission.denied':
    "Access not granted. The extension can't send requests to this address.",
  'common.permission.requestFailed': 'The access request failed. Check the address and try again.',
  'common.permission.demoDisabled': 'Not available in demo mode',
  'common.permission.requestTitle': 'Request access to {pattern}',

  'common.playback.mode': 'Playback',
  'common.playback.buffered': 'Stay in sync',
  'common.playback.continuous': 'Continuous',
  'common.playback.buffer': 'Translation buffer',
  'common.playback.seconds': '{count} s',
  'common.playback.secondsRecommended': '{count} s (recommended)',
  'common.playback.bufferedHint':
    'Buffers translations before playing and keeps reading ahead; pauses to wait if translation falls behind.',
  'common.playback.ready': 'Buffer ready',
  'common.playback.preparing': 'Buffering translations',
  'common.playback.unavailable': "This video can't be read ahead",
  'common.playback.blocked': 'Buffer stalled',
  'common.playback.switchContinuous': 'Switch to continuous',
  'common.playback.progress': '{ready} s of {target} s ready',
  'common.playback.progressAria': 'Translation buffer progress',
  'common.playback.blockedHint':
    'Switch to continuous playback, then click the video to continue. Subtitles and voice-over may lag behind the picture.',
  'common.playback.systemVoiceHint':
    'System voices speak when each subtitle is due; buffer progress shows translations already prepared.',
  'common.playback.continuousHint':
    'The video plays continuously while translating; subtitles and voice-over may lag behind the picture.',
};

export const common = { 'zh-CN': zhCN, en };
