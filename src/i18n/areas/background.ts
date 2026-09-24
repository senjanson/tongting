/**
 * background 区域文案。键名以 `background.` 开头；en 必须与 zh-CN 键完全一致（类型检查 + 单测保证）。
 * 覆盖 service worker、服务适配、离屏文档与 YouTube 内容脚本中面向用户的提示。
 */
const zhCN = {
  'background.check.formatJsonSchema': '结构化输出 json_schema（严格模式）',
  'background.check.formatJsonObject': 'JSON 模式（服务拒绝了 json_schema，已降级）',
  'background.check.formatPrompt':
    '仅靠提示词约束 JSON（服务不支持结构化输出，已降级，格式错误风险更高）',
  'background.check.withDetail': '{message}（服务返回：{detail}）',
  'background.check.skippedPrereq': '未检查：前置检查未通过。',
  'background.check.skippedBaseUrl': '未检查：请先填写有效的服务地址。',
  'background.check.hostPermissionMissing':
    '尚未授予访问 {origin} 的权限：请在设置页点击「授权访问」后重新检查。',
  'background.check.hostPermissionGranted': '已授予访问 {origin} 的权限。',
  'background.check.reachable': '服务可以连接。',
  'background.check.modelListCount':
    '服务列出了 {count} 个模型；列表不代表每个模型都有权限，所选模型仍需实测。',
  'background.check.modelListEmpty': '服务返回了空的模型列表，可手动填写模型 ID 继续检查。',
  'background.check.reachableHttp': '服务可以连接（收到了 HTTP 响应）。',
  'background.check.keyInvalid': 'API Key 无效或已失效（401）：请重新填写 Key。',
  'background.check.keyMissing': '尚未填写 API Key：请先填写 Key 再检查。',
  'background.check.modelListFailedStillTest':
    '获取模型列表失败：{message} 下面仍会用手动填写的模型实测。',
  'background.check.modelListUnsupported':
    '服务未提供模型列表接口：请手动填写模型 ID，下面的模型检查仍会实测。',
  'background.check.modelListForbidden':
    '当前 Key 无权读取模型列表（403）：可手动填写模型 ID，下面的模型检查仍会实测。',
  'background.check.modelListNotJson':
    '返回的不是模型列表 JSON：请确认 Base URL 指向 API 根地址；可手动填写模型 ID 继续。',
  'background.check.modelListFailed': '获取模型列表失败：{message} 可手动填写模型 ID 继续。',
  'background.check.authListOnly': '模型列表接口接受了该 Key；是否能调用翻译以下方翻译测试为准。',
  'background.check.modelMissing': '尚未选择模型：请从列表选择或手动填写模型 ID。',
  'background.check.reachabilityUnconfirmed':
    '模型列表请求未得到响应（{message}），且未填写模型，无法用翻译调用确认可达性。',
  'background.check.reachableViaTranslation':
    '服务可以连接（翻译接口有响应；模型列表请求未成功）。',
  'background.check.unreachable': '无法连接到服务。',
  'background.check.unconfirmedUnreachable': '未能确认：服务不可达。',
  'background.check.translationUnreachable': '翻译测试未完成：服务不可达。',
  'background.check.skippedNeedsTranslation': '未检查：需先通过翻译测试。',
  'background.check.authVerified': 'API Key 已通过翻译调用验证。',
  'background.check.modelVerifiedNotListed':
    '模型 {model} 可以调用（未出现在模型列表中，但实测可用）。',
  'background.check.modelVerified': '模型 {model} 可以调用。',
  'background.check.qualityNote': '；注意：测试译文未保留数字或否定，建议对比其他模型',
  'background.check.translationPassed':
    '翻译测试通过（{protocol}；{format}；结果与目标语言校验通过{note}）。',
  'background.check.streamIgnored': '服务忽略了流式参数并返回普通 JSON：请关闭「流式返回」。',
  'background.check.streamNoDone':
    '流式返回内容完整，但只收到 finish_reason、没有收到 [DONE] 结束事件（部分结果 {count} 次）；如遇截断请关闭「流式返回」。',
  'background.check.streamOk': '流式返回正常（收到 {end} 结束事件，部分结果 {count} 次）。',
  'background.check.streamRejected': '服务不接受流式请求：请关闭「流式返回」。',
  'background.check.streamInterrupted':
    '流式响应没有正常结束（缺少结束事件或连接中断）：建议关闭「流式返回」。',
  'background.check.streamFailed': '流式测试失败：{message}',
  'background.check.authListButTranslateFailed':
    '模型列表接口接受了该 Key，但翻译调用没有成功，无法最终确认。',
  'background.check.authUnconfirmed': '未能单独确认 Key 是否有效：请参考下方模型与翻译检查结果。',
  'background.check.noProtocol':
    '服务既不支持 Responses 也不支持 Chat Completions 接口：请确认 Base URL 是否为 sub2api 的 API 地址。',
  'background.check.protocolUnsupported':
    '服务不支持 {protocol} 接口：请在设置中切换协议或改为自动检测。',
  'background.check.skippedAuthFailed': '未检查：认证未通过。',
  'background.check.translationAuthFailed': '翻译测试未通过：认证失败。',
  'background.check.modelForbidden':
    '没有使用模型 {model} 的权限（403）：请检查 Key 所属分组的模型权限，或更换模型。',
  'background.check.translationModelForbidden': '翻译测试未通过：模型无权限。',
  'background.check.modelNotFound':
    '服务找不到模型 {model}：请确认模型 ID 拼写，或从模型列表中选择。',
  'background.check.translationModelUnavailable': '翻译测试未通过：模型不可用。',
  'background.check.authAcceptedByTranslation': 'API Key 已被翻译接口接受（返回了内容）。',
  'background.check.modelOutputInvalid': '模型 {model} 可以调用，但返回内容未通过校验。',
  'background.check.translationOutputInvalid':
    '模型返回的译文未通过格式或语言校验：建议更换模型，或将推理参数改为「不发送」后重试。',
  'background.check.probeRejected': '服务拒绝了本次探测请求，无法据此确认 Key 是否可用于翻译。',
  'background.check.unconfirmedProbeRejected': '未能确认：探测请求被拒绝。',
  'background.check.translationRejected': '翻译测试未通过：{message}',
  'background.check.unconfirmedNoResult': '未能确认：翻译测试没有得到模型结果。',
  'background.check.translationFailed': '翻译测试失败：{message}',
  'background.coordinator.systemVoicesCount':
    '系统语音中有 {count} 个可用于当前目标语言的声音（实际朗读效果请试听确认）。',
  'background.coordinator.notProbed':
    '检查 sub2api {what}需要一次实际调用（可能产生少量费用）；勾选「允许实际调用」后重新检查。',
  'background.coordinator.asrProbeOk':
    '识别接口调用成功（测试音频为 1 秒合成音，只验证接口与认证，不代表识别准确度{note}）。',
  'background.coordinator.asrProbeEmptyNote': '；返回文本为空属正常',
  'background.coordinator.ttsProbeOk':
    '合成接口返回了 {kb} KB 音频（{format}）；声音效果请在视频中试听确认。',
  'background.coordinator.localAsrReady':
    '本地识别服务可用（模型 {model}，{device}）。配对令牌将在首次识别时验证。',
  'background.coordinator.localAsrUnreachable': '无法连接本地识别服务（{origin}），请确认已启动。',
  'background.coordinator.hostPermissionRevoked':
    '服务访问权限已被撤回，翻译、捕获与配音已停止。请在设置页重新授权后点击「开始翻译」。',
  'background.coordinator.workerRestartedPaused':
    '扩展后台已重启，暂停中的翻译无法自动恢复。请点击「开始翻译」重新开始，已保存的字幕记录不受影响。',
  'background.coordinator.movedToOtherTab': '翻译已切换到另一个标签页，本页已停止。',
  'background.coordinator.otherTabNotStopped':
    '另一个标签页的翻译未能及时停止，为避免重复占用音频与请求，本次未开始。请关闭或刷新另一个标签页后重试。',
  'background.coordinator.startRetriesExhausted':
    '翻译多次启动未能完成，已停止。请刷新页面后重新开始；若反复出现，请在设置页检查服务配置。',
  'background.coordinator.offscreenLost': '音频处理组件意外中断，已停止语音识别。请重新开始翻译。',
  'background.coordinator.noActiveSession': '当前标签页没有进行中的翻译。',
  'background.coordinator.sourceTabUnavailable': '源视频标签页不可用，无法跳转。',
  'background.coordinator.stateChanged': '翻译状态已变化，界面已刷新，请确认后重试。',
  'background.coordinator.notYoutubeVideoTab':
    '当前标签页不是可播放的 YouTube 视频页，或页面尚未连接。请打开视频页面后重试（必要时刷新页面）。',
  'background.coordinator.noActiveSessionStart': '当前标签页没有进行中的翻译，请点击「开始翻译」。',
  'background.coordinator.invalidSettings': '设置值无效，未应用。',
  'background.coordinator.systemVoicesNone':
    '系统语音中没有当前目标语言的声音，配音将不可用，仅显示字幕。',
  'background.coordinator.configBecameInvalid':
    '服务配置已变化且当前不可用（地址、Key、协议、模型或访问权限缺失），已停止翻译。请完成设置后重新开始。',
  'background.coordinator.emptyKey': 'API Key 不能为空。',
  'background.coordinator.needBaseUrlSub2api': '请先填写有效的 sub2api 服务地址。',
  'background.coordinator.needApiKey': '请先填写 API Key。',
  'background.coordinator.needModelId': '请先填写模型 ID。',
  'background.coordinator.noHostPermission': '尚未授予访问服务地址的权限。',
  'background.coordinator.asrNotEnabled': '未启用语音识别服务；无字幕视频将无法翻译。',
  'background.coordinator.localAsrUrlInvalid': '本地识别服务地址无效。',
  'background.coordinator.localAsrNoPermission': '尚未授予访问本地识别服务的权限。',
  'background.coordinator.unknownModel': '未知',
  'background.coordinator.unknownDevice': '未知设备',
  'background.coordinator.localAsrNoToken': '本地识别服务在线，但尚未填写配对令牌。',
  'background.coordinator.localAsrLoading': '本地识别服务正在加载模型，请稍后重试。',
  'background.coordinator.saveKeyAndModelFirst': '请先在设置中保存 API Key 和翻译模型。',
  'background.coordinator.grantHostPermissionInSettings': '请先在设置中授予访问服务地址的权限。',
  'background.coordinator.needValidBaseUrl': '请先填写有效的服务地址。',
  'background.coordinator.grantHostPermission': '请先授予访问服务地址的权限。',
  'background.coordinator.dubbingActive': '配音进行中，暂不能试听。请先暂停翻译。',
  'background.coordinator.previewNotStarted': '系统语音没有开始朗读，请检查所选声音。',
  'background.coordinator.secretCleanupIncomplete':
    '凭证已停止使用，但本机存储副本尚未全部清除。请点击「重试清理」；清理完成前不要把它视为已彻底删除。',
  'background.coordinator.checkReplaced': '本次检查已被新的检查取代。',
  'background.coordinator.checkSuperseded': '配置已变化，本次检查结果作废，请重新检查。',
  'background.coordinator.discoverySuperseded':
    '服务地址、Key 或访问权限已变化，本次模型列表作废，请重新获取。',
  'background.coordinator.discoveryReplaced': '本次获取已被新的获取请求取代。',
  'background.coordinator.asrWhat': '语音识别',
  'background.coordinator.ttsWhat': '语音合成',
  'background.coordinator.unknownFormat': '未知格式',
  'background.session.dubError': '配音出错：{message}',
  'background.session.statusBuffering': '正在缓冲翻译 · {seconds} 秒',
  'background.session.translationBlocked': '已停止发送翻译请求：{message}',
  'background.session.rateLimited': '服务限流，约 {seconds} 秒后自动重试。',
  'background.session.translationFailing': '部分字幕翻译失败：{message}',
  'background.session.liveUnsupported':
    '暂不支持直播：直播的字幕与音频时间轴尚未验证。请在普通录播视频上使用。',
  'background.session.shortsUnverified': 'Shorts 页面尚未经过验证，字幕位置与时间可能不准确。',
  'background.session.partialCaptionsBuffered':
    '无法读取完整字幕轨道，当前只能读取部分字幕。请在设置中将播放模式切换为「连续播放」，即可使用增量字幕翻译；如需「同步优先」，请将字幕来源改为「缺失时识别语音」，并配置支持音频预读的本地识别服务。',
  'background.session.bridgeNotReadyCaptionsOnly':
    '页面字幕接入尚未就绪（播放器可能仍在加载），暂时读取不到字幕。请稍后重试。',
  'background.session.bridgeNotReadyNoAsr':
    '页面字幕接入尚未就绪（播放器可能仍在加载），且尚未配置语音识别服务。请稍后重试；视频可继续正常播放。',
  'background.session.noCaptions':
    '此视频没有可读取的字幕。可在设置中把字幕来源改为「缺失时识别语音」并配置语音识别服务。',
  'background.session.missingBaseUrl': '尚未配置 sub2api 服务地址，请先在设置页填写。',
  'background.session.missingApiKey':
    '尚未填写 API Key，请在设置页填写（默认只保存在本次浏览器会话）。',
  'background.session.missingModel': '尚未选择翻译模型。',
  'background.session.missingHostPermission':
    '尚未授予访问 sub2api 服务地址的权限，请在设置页点击「授予访问权限」。',
  'background.session.protocolUndetermined':
    '无法自动确定接口协议，请在设置页「检查连接」或手动选择协议。',
  'background.session.trackLoadTimeout': '读取字幕轨道超时',
  'background.session.incrementalCaptions':
    '无法读取完整字幕轨道，改为读取播放器当前显示的字幕：只覆盖已播放部分，且需保持 YouTube 字幕开启。',
  'background.session.preloadLocalRequired':
    '无完整字幕时，同步优先需要启用音频预读的本地识别服务。也可切换为「连续播放」。',
  'background.session.bufferPreparing': '正在准备翻译，缓冲完成后按视频时间播放。',
  'background.session.bufferSegmentFailed': '当前片段翻译失败，请重试失败项或切换连续播放。',
  'background.session.bufferCannotPreload': '此来源无法提前读取，请配置音频预读或切换连续播放。',
  'background.session.bufferReady': '翻译已缓冲，播放期间继续准备后续内容。',
  'background.session.captureFailed':
    '无法捕获此标签页的声音。请在该 YouTube 标签页点击浏览器工具栏中的「同听」图标（或按快捷键 Alt+T）后重试。',
  'background.session.asrNotConfigured':
    '此视频没有可读取的字幕，且尚未配置语音识别服务。请在设置页「识别与播放」中配置后重试。视频可继续正常播放。',
  'background.session.asrLocalUrlInvalid': '本地识别服务地址无效，只允许 http://127.0.0.1:<端口>。',
  'background.session.asrTokenMissing': '尚未填写本地识别服务的配对令牌。',
  'background.session.asrNoHostPermission':
    '尚未授予访问本地识别服务的权限，请在设置页点击「授予访问权限」。',
  'background.session.asrSub2apiConfig': 'sub2api 服务地址或 Key 未配置。',
  'background.session.asrModelMissing': '尚未填写 sub2api 语音识别模型。',
  'background.session.offscreenLost': '音频处理组件意外中断，已停止语音识别。请重新开始翻译。',
  'background.session.ttsDisabled': '未启用语音合成服务，当前仅显示字幕。',
  'background.session.captureLeaseExpired': '音频捕获因后台失联而自动停止，请重新开始翻译。',
  'background.session.captureEnded':
    '标签页音频捕获已结束（可能是权限被撤回或页面音频不可用），已停止语音识别。请重新开始翻译。',
  'background.session.asrBacklog':
    '语音识别速度跟不上播放，已跳过部分音频。可暂停视频等待，或在本地识别服务中换用更小的模型。',
  'background.session.asrUnavailable':
    '语音识别服务暂不可用（模型未就绪或服务繁忙），部分音频未能识别。',
  'background.session.asrFailing': '部分音频识别失败，已跳过。请检查语音识别服务状态。',
  'background.session.videoEnded': '视频已结束，已停止音频捕获与识别。',
  'background.session.backfillUnsupported':
    '只有读取到完整字幕轨道时才能翻译全片；当前字幕来源只覆盖已播放的部分。',
  'background.session.statusBufferPaused': '缓冲暂停，详见侧栏',
  'background.session.statusPreparing': '正在准备',
  'background.session.statusPaused': '翻译已暂停',
  'background.session.statusBlocked': '翻译已停止，详见侧栏',
  'background.session.statusRateLimited': '服务限流，稍后自动重试',
  'background.session.statusFailing': '部分字幕翻译失败，正在重试',
  'background.session.statusAsrRunning': '语音识别翻译中',
  'background.session.statusRunning': '翻译中',
  'background.session.saveTranscriptFailed': '字幕记录保存失败，本次字幕仅保留在内存中。',
  'background.session.noDubVoice': '当前目标语言没有可用的配音声音，已降级为仅字幕。',
  'background.http.endpointUnsupported':
    '服务不支持该接口（{status}）：请在设置中切换协议（Responses / Chat Completions）。',
  'background.http.rateLimited': '请求过于频繁（429），约 {seconds} 秒后再试。',
  'background.http.requestRejected':
    '服务拒绝了这次翻译请求（{status}），其余字幕会继续翻译；持续出现请检查模型与协议设置。',
  'background.http.serverError':
    '服务暂时异常（{status}），稍后会自动重试；持续失败请检查 sub2api 上游状态。',
  'background.http.unexpectedStatus': '服务返回了无法处理的状态（{status}）。',
  'background.http.timeout':
    '服务在 {seconds} 秒内没有完成响应，稍后会自动重试；持续超时可在设置中调大超时时间。',
  'background.http.redirectBlocked':
    '服务返回了重定向，为避免把 API Key 发往其他地址已停止请求；请把 Base URL 改为最终的 API 地址。',
  'background.http.authInvalid': 'API Key 无效或已失效（401）：请在设置中重新填写 Key 后再试。',
  'background.http.quota': '服务提示余额或额度不足：请到 sub2api 后台确认余额与分组额度后再试。',
  'background.http.permission':
    '没有使用该模型或接口的权限（403）：请检查 Key 所属分组的模型权限，或更换模型。',
  'background.http.modelNotFound':
    '服务找不到该模型（404）：请确认模型 ID 拼写，或从模型列表中重新选择。',
  'background.http.endpointNotFound':
    '服务不支持该接口（404）：请确认 Base URL 是否正确，或在设置中切换协议。',
  'background.http.requestTimeout': '服务处理超时（408），稍后会自动重试。',
  'background.http.payloadTooLarge': '请求内容过大（413），请减少单批字幕数量。',
  'background.http.rateLimitedNoRetryAfter': '请求过于频繁（429），已暂停预取并稍后重试。',
  'background.http.modelIdRejected':
    '服务不接受该模型 ID：请确认模型名称，或从模型列表中重新选择。',
  'background.http.unsupportedParameter':
    '服务不接受本次请求中的可选参数（推理参数或结构化输出）：如设置了推理参数，请改为「不发送」后重试。',
  'background.http.contentRejected': '服务的内容审核拒绝了这段字幕，已跳过；其余字幕会继续翻译。',
  'background.http.contextTooLong': '这批字幕超出模型的上下文长度，将改为逐条翻译。',
  'background.http.networkError':
    '无法连接到服务：请检查网络、Base URL 与证书，并确认已授予该地址的访问权限。',
  'background.http.streamInterrupted': '流式响应在结束前中断，本次结果已丢弃，稍后会自动重试。',
  'background.audioHttp.redirect': '{service}返回了重定向，已拒绝跟随以保护凭证；请检查服务地址。',
  'background.audioHttp.timeout': '{service}响应超时',
  'background.audioHttp.unreachable':
    '无法连接{service}：可能是网络中断、跨域被拒绝或服务尝试重定向（已禁止跟随）。',
  'background.audioHttp.badRequest': '{service}拒绝了请求参数（400）',
  'background.audioHttp.quota': '{service}余额或额度不足。',
  'background.audioHttp.forbidden': '当前 Key 无权使用{service}或所选模型（403）。',
  'background.audioHttp.notFound': '{service}接口不存在（404）：服务可能不支持该能力或地址有误。',
  'background.audioHttp.requestTimeout': '{service}处理超时（408）',
  'background.audioHttp.audioTooLong': '{service}拒绝了过长的音频（413）',
  'background.audioHttp.unsupportedMedia': '{service}不接受该音频格式（415）',
  'background.audioHttp.quota429': '{service}额度不足（429）。',
  'background.audioHttp.rateLimited': '{service}繁忙或限流（429），稍后重试。',
  'background.audioHttp.serverError': '{service}服务端错误（{status}）',
  'background.audioHttp.unexpectedStatus': '{service}返回异常状态（{status}）',
  'background.audioHttp.localUrlInvalid': '本地识别服务地址无效，应为 http://127.0.0.1:端口',
  'background.audioHttp.localUrlNotLoopback':
    '本地识别服务地址只允许 http://127.0.0.1:端口（不支持 localhost）',
  'background.audioHttp.localUrlExtras': '本地识别服务地址不能包含账号、查询参数或锚点',
  'background.audioHttp.baseUrlInvalid': 'sub2api 地址无效',
  'background.audioHttp.baseUrlInsecure': 'sub2api 地址必须使用 HTTPS（本机开发地址除外）',
  'background.audioHttp.baseUrlExtras': 'sub2api 地址不能包含账号、查询参数或锚点',
  'background.audioHttp.bodyTooLarge': '服务返回的数据过大',
  'background.audioHttp.cancelled': '操作已取消',
  'background.audioHttp.localUnreachable':
    '无法连接本地识别服务：请确认服务已启动、地址为 http://127.0.0.1:端口，并已授予扩展访问 http://127.0.0.1 的权限。',
  'background.audioHttp.preloadUnavailable':
    '本地识别服务未启用音频预读，或缺少依赖。请以 --youtube-preload 启动服务，并确认已安装 yt-dlp、ffmpeg 和 Node.js；也可切换为「连续播放」。',
  'background.audioHttp.preloadUnsupportedVideo':
    '此视频不支持音频预读，可能为直播、受限视频或没有可用音频。请使用普通公开视频；录播视频也可尝试「连续播放」。',
  'background.audioHttp.preloadPastEnd': '预读位置已超过视频结尾，请跳回视频有效时间后重试。',
  'background.audioHttp.preloadAudioFailed':
    '无法读取视频音频，请检查视频访问权限、网络或代理后重试；也可切换为「连续播放」。',
  'background.audioHttp.preloadTimeout':
    '视频音频预读超时，请检查网络或代理后重试；也可切换为「连续播放」。',
  'background.audioHttp.localLanguageUnsupported':
    '本地识别服务不支持当前识别语言，请改为「自动识别」或其他语言。',
  'background.audioHttp.localTokenInvalid': '本地识别服务配对令牌无效，请在设置中重新配对。',
  'background.audioHttp.keyInvalid': 'API Key 无效或已失效，请在设置中检查。',
  'background.audioHttp.localForbidden':
    '本地识别服务拒绝了请求（403）：请使用 http://127.0.0.1:端口 地址，并确认请求来自扩展。',
  'background.audioHttp.localModelLoading': '本地识别模型正在加载，请稍候。',
  'background.audioHttp.localModelUnavailable':
    '本地识别服务的模型不可用，请检查服务日志或重新启动服务。',
  'background.audioHttp.localUnavailable': '本地识别服务暂不可用（503）。',
  'background.audioHttp.serviceLocalAsr': '本地识别服务',
  'background.audioHttp.serviceSub2apiAsr': 'sub2api 语音识别',
  'background.audioHttp.serviceSub2apiTts': 'sub2api 语音合成',
  'background.errors.cancelled': '操作已取消',
  'background.errors.internal': '发生内部错误，请重试；若持续出现请查看扩展日志。',
  'background.baseUrl.empty': '请填写 sub2api 服务地址（Base URL），例如 https://api.example.com。',
  'background.baseUrl.tooLong': '服务地址过长，请只填写 API 根地址。',
  'background.baseUrl.whitespace': '服务地址中包含空白字符，请检查后重新填写。',
  'background.baseUrl.noScheme': '服务地址需要以 https:// 开头，例如 https://api.example.com。',
  'background.baseUrl.invalid': '服务地址格式无效，请填写类似 https://api.example.com 的地址。',
  'background.baseUrl.scheme': '服务地址只支持 https://（本机调试可使用 http://127.0.0.1）。',
  'background.baseUrl.noHost': '服务地址缺少主机名，请检查后重新填写。',
  'background.baseUrl.credentials':
    '服务地址不能包含用户名或密码，API Key 请在「API Key」输入框填写。',
  'background.baseUrl.query': '服务地址不能包含查询参数（? 之后的内容），请只填写 API 根地址。',
  'background.baseUrl.fragment': '服务地址不能包含 # 片段，请只填写 API 根地址。',
  'background.baseUrl.hostInvalid':
    '服务地址的主机名无效：请填写具体的域名或 IP，不能包含 * 等通配符或编码字符。',
  'background.baseUrl.insecure':
    '为保护 API Key，服务地址必须使用 https://；http 仅允许本机调试地址 127.0.0.1。',
  'background.protocol.truncated': '模型输出被截断，本批结果已丢弃，稍后会以更小的批次重试。',
  'background.protocol.refused': '模型拒绝翻译这段字幕，已标记为失败，可稍后重试或更换模型。',
  'background.protocol.empty': '模型没有返回译文内容，稍后可重试。',
  'background.protocol.rateLimited': '请求过于频繁（服务在响应中报告限流），已暂停预取并稍后重试。',
  'background.protocol.quota':
    '服务提示余额或额度不足：请到 sub2api 后台确认余额与分组额度后再试。',
  'background.protocol.serverError': '服务在处理过程中返回错误，稍后会自动重试。',
  'background.cache.emptyValue': '空译文不能写入缓存。',
  'background.cache.tooLarge': '译文过长，未写入缓存。',
  'background.cache.readFailed': '读取翻译缓存失败，将直接请求翻译。',
  'background.cache.writeFailed': '写入翻译缓存失败，本次译文仍然可用。',
  'background.cache.clearFailed': '清空翻译缓存失败，请重试。',
  'background.cloudTts.notConfigured':
    '尚未配置云端配音服务（地址、Key、模型），配音不可用；字幕仍可正常使用。',
  'background.cloudTts.failed': '云端配音失败',
  'background.cloudTts.disposed': '配音引擎已释放',
  'background.cloudTts.noOwner': '当前没有可以播放配音的会话',
  'background.cloudTts.requestFailed': '云端配音请求失败',
  'background.textProvider.apiKeyMissing': '尚未填写 API Key：请在设置页填写后再开始翻译。',
  'background.textProvider.modelMissing': '尚未选择模型：请在设置页选择或手动填写模型 ID。',
  'background.textProvider.protocolInvalid': '协议必须是 Responses 或 Chat Completions。',
  'background.textProvider.batchInvalidIds': '翻译批次中的字幕 ID 为空或重复。',
  'background.textProvider.outputInvalid':
    '模型返回的译文未通过校验（缺少字幕 ID、重复或格式错误），本批已标记失败，可稍后重试。',
  'background.sub2apiAsr.noKey': '尚未设置 API Key',
  'background.sub2apiAsr.noModel': '尚未选择语音识别模型',
  'background.sub2apiAsr.segmentTooLarge': '识别分段过大',
  'background.sub2apiAsr.noHealthCheck':
    'sub2api 语音识别没有免费的健康检查接口，需要在连接检查中显式进行一次（可能计费的）识别测试。',
  'background.sub2apiAsr.badResponse': 'sub2api 语音识别返回的数据格式无法识别',
  'background.scheduler.noValidTranslation': '模型没有返回有效译文。',
  'background.scheduler.cueNoValidTranslation':
    '模型没有返回这条字幕的有效译文（已做有限修复），可稍后重试。',
  'background.scheduler.unexpectedAbort':
    '请求被意外中止（不是暂停或跳转触发的），稍后会自动重试。',
  'background.scheduler.circuitOpen':
    '连续 {count} 次翻译请求没有得到有效译文，已暂停发送以免浪费额度；请检查模型或服务状态后点击「重试」。',
  'background.dubbing.speakFailed': '配音朗读启动失败',
  'background.dubbing.voicesUnavailable': '无法读取可用配音声音列表',
  'background.dubbing.stalled': '配音引擎长时间没有开始朗读，已跳过该句。',
  'background.dubbing.noVoice':
    '没有可用于「{language}」的配音声音，配音不可用，字幕仍可正常使用。可在设置中改用其他配音服务。',
  'background.search.invalidOutput':
    '模型未返回有效结果：需要第一条原文直译和两条简短搜索词，且使用所选的搜索语言，请重新生成。',
  'background.search.notConfigured': '请先在设置中保存 API Key 和翻译模型。',
  'background.search.rejected': '服务拒绝了搜索词生成请求，请检查设置中的模型和协议。',
  'background.textHttp.failed': '请求处理失败，请重试。',
  'background.textHttp.originMismatch': '请求地址与已配置的服务地址不一致，已拒绝发送。',
  'background.textHttp.bodyTooLarge': '服务返回的内容过大，已停止读取。',
  'background.textHttp.notJson':
    '服务返回的不是有效 JSON：请确认 Base URL 指向 API 根地址而不是网页。',
  'background.localAsr.notPaired': '尚未与本地识别服务配对',
  'background.localAsr.segmentTooLarge': '识别分段超过本地服务的大小限制',
  'background.localAsr.badResponse': '本地识别服务返回的数据格式不符合约定',
  'background.localAsr.healthFailed': '本地识别健康检查失败',
  'background.preload.needVideoAndPairing': '音频预读需要有效的 YouTube 视频和本地识别配对。',
  'background.preload.needUpdate': '本地识别服务需要更新并启用音频预读。也可切换为「连续播放」。',
  'background.preload.badRange': '音频预读返回的时间范围无效，已停止以避免字幕错位。',
  'background.recognition.encodeFailed': '识别音频编码失败',
  'background.recognition.stalled': '语音识别请求长时间没有完成，已中止。',
  'background.recognition.failed': '语音识别失败',
  'background.sub2apiTts.noAudio': 'sub2api 语音合成没有返回音频数据',
  'background.sub2apiTts.emptyAudio': 'sub2api 语音合成返回了空音频',
  'background.textFormat.responsesUnrecognized': '服务返回的 Responses 结果格式无法识别。',
  'background.textFormat.streamEventInvalid': '流式响应中出现无法解析的事件，本次结果已丢弃。',
  'background.textFormat.chatUnrecognized': '服务返回的 Chat Completions 结果格式无法识别。',
  'background.rpc.timeout': '页面或后台组件响应超时',
  'background.rpc.disconnected': '连接已断开',
  'background.preload.failed': '音频预读失败，请重试或切换为「连续播放」。',
  'background.systemTts.failed': '系统语音朗读失败，可尝试更换声音或改为仅字幕。',
  'background.textHttp.streamTooLarge': '服务返回的流式内容过大，已停止读取。',
  'background.models.unrecognized': '服务返回的模型列表格式无法识别，可手动填写模型 ID。',
  'background.search.tooMany': '已有多个搜索请求正在生成，请稍后再试。',
  'background.connections.invalidCommand': '命令格式无效，已拒绝',
  'background.offscreen.ttsStopped': '该配音句已被停止，忽略迟到的播放请求。',
  'background.offscreen.ttsDecodeFailed': '无法解码云端配音音频',
  'background.offscreen.ttsPlayFailed': '云端配音播放失败',
  'background.offscreen.captureDenied':
    '浏览器拒绝了标签页音频捕获，请在视频页面点击扩展按钮后重新开始。',
  'background.offscreen.captureFailed':
    '无法捕获标签页音频（捕获标识可能已过期或标签页不可捕获），请重新开始。',
  'background.offscreen.noAudioTrack': '捕获到的标签页流中没有音频轨道',
  'background.offscreen.audioSetupFailed': '无法建立音频处理（AudioContext/AudioWorklet）',
  'background.offscreen.asrConfigInvalid': '语音识别配置无效',
  'background.offscreen.contextClosed': '音频处理上下文被意外关闭，已停止识别，请重新开始。',
  'background.offscreen.captureEnded':
    '标签页音频捕获已结束（标签页关闭、导航或权限被撤回），需要重新开始。',
  'background.offscreen.inputQuiet':
    '捕获到的视频声音过小，持续被判为无语音，未送识别。请调高 YouTube 播放器音量或取消静音。',
  'background.offscreen.notRunning': '音频捕获未在运行',
  'background.offscreen.leaseMismatch': '音频捕获租约已失效或不属于当前会话，需要重新开始。',
  'background.offscreen.leaseExpired': '后台长时间没有确认音频会话，已自动停止捕获。',
  'background.offscreen.unresponsive': 'offscreen 文档没有响应握手',
  'background.offscreen.notConnected': 'offscreen 未连接',
  'background.offscreen.disconnected': 'offscreen 连接已断开',
  'background.offscreen.createFailed': '无法创建音频处理文档（offscreen）',
  'background.offscreen.missing': 'offscreen 文档不存在',
  'background.offscreen.reconnected': 'offscreen 已重新连接，旧请求作废',
  'background.offscreen.badRequest': 'offscreen 请求参数无效',
  'background.offscreen.apiUnavailable': '当前环境不支持 offscreen API',
  'background.offscreen.disconnectedReason': 'offscreen 连接已断开（{reason}）',
  'background.offscreen.timeout': 'offscreen 请求超时（{kind}）',
  'background.youtube.staleVideo': '页面上的视频已经变化，旧请求已忽略。',
  'background.youtube.navigationChanged': '页面已切换到其他视频，操作已取消。',
  'background.youtube.playerUnavailable': '未找到页面中的视频播放器，请等待视频加载后重试。',
  'background.youtube.adPlaying': '广告播放中，请在正片开始后重试。',
  'background.youtube.noTracks': '当前视频没有可读取的字幕轨道。',
  'background.youtube.trackNotFound': '找不到指定的字幕轨道，可能已随视频切换失效。',
  'background.youtube.loadTimeout':
    '字幕轨道加载超时：播放器没有返回可读取的字幕内容。可改用当前显示字幕或语音识别。',
  'background.youtube.parseFailed': '字幕内容格式无法识别，无法读取完整轨道。',
  'background.youtube.captionsPlayerUnavailable': '暂时无法读取播放器字幕信息，请稍后重试。',
  'background.youtube.bridgeUnavailable': '页面字幕接入未就绪，请刷新 YouTube 页面后重试。',
  'background.youtube.duckFailed': '无法调整原声音量。',
  'background.youtube.internal': '页面接入发生内部错误，请刷新页面后重试。',
  'background.overlay.phase.idle': '未开始',
  'background.overlay.phase.configuring': '需要配置',
  'background.overlay.phase.starting': '正在准备',
  'background.overlay.phase.running': '运行中',
  'background.overlay.phase.pausing': '正在暂停',
  'background.overlay.phase.paused': '已暂停',
  'background.overlay.phase.stopping': '正在停止',
  'background.overlay.phase.error': '出错',
  'background.overlay.badge': '同听 · {label}',
} as const;

const en: Record<keyof typeof zhCN, string> = {
  'background.check.formatJsonSchema': 'structured output json_schema (strict)',
  'background.check.formatJsonObject': 'JSON mode (the service rejected json_schema; fell back)',
  'background.check.formatPrompt':
    'JSON enforced by prompt only (the service does not support structured output; fell back, higher risk of format errors)',
  'background.check.withDetail': '{message} (service returned: {detail})',
  'background.check.skippedPrereq': 'Not checked: an earlier check failed.',
  'background.check.skippedBaseUrl': 'Not checked: enter a valid service URL first.',
  'background.check.hostPermissionMissing':
    'Access to {origin} has not been granted. Click "Grant access" in Settings, then check again.',
  'background.check.hostPermissionGranted': 'Access to {origin} is granted.',
  'background.check.reachable': 'The service is reachable.',
  'background.check.modelListCount':
    'The service listed {count} models. Being listed does not guarantee access; the selected model is still tested below.',
  'background.check.modelListEmpty':
    'The service returned an empty model list. Enter a model ID manually to continue.',
  'background.check.reachableHttp': 'The service is reachable (an HTTP response was received).',
  'background.check.keyInvalid': 'The API key is invalid or expired (401). Enter the key again.',
  'background.check.keyMissing': 'No API key yet. Enter a key, then check again.',
  'background.check.modelListFailedStillTest':
    'Could not load the model list: {message} The manually entered model is still tested below.',
  'background.check.modelListUnsupported':
    'The service has no model list endpoint. Enter a model ID manually; the model is still tested below.',
  'background.check.modelListForbidden':
    'This key cannot read the model list (403). Enter a model ID manually; the model is still tested below.',
  'background.check.modelListNotJson':
    'The response is not a model list JSON. Make sure the Base URL points to the API root, or enter a model ID manually to continue.',
  'background.check.modelListFailed':
    'Could not load the model list: {message} Enter a model ID manually to continue.',
  'background.check.authListOnly':
    'The model list endpoint accepted this key; whether it can translate is shown by the translation test below.',
  'background.check.modelMissing': 'No model selected. Pick one from the list or enter a model ID.',
  'background.check.reachabilityUnconfirmed':
    'The model list request got no response ({message}) and no model is set, so reachability cannot be confirmed with a translation call.',
  'background.check.reachableViaTranslation':
    'The service is reachable (the translation endpoint responded; the model list request failed).',
  'background.check.unreachable': 'Cannot connect to the service.',
  'background.check.unconfirmedUnreachable': 'Not confirmed: the service is unreachable.',
  'background.check.translationUnreachable':
    'Translation test not completed: the service is unreachable.',
  'background.check.skippedNeedsTranslation': 'Not checked: the translation test must pass first.',
  'background.check.authVerified': 'The API key was verified by a translation call.',
  'background.check.modelVerifiedNotListed':
    'Model {model} works (not in the model list, but a real call succeeded).',
  'background.check.modelVerified': 'Model {model} works.',
  'background.check.qualityNote':
    '; note: the test translation dropped the number or the negation, so consider comparing other models',
  'background.check.translationPassed':
    'Translation test passed ({protocol}; {format}; output and target language checks passed{note}).',
  'background.check.streamIgnored':
    'The service ignored the streaming parameter and returned plain JSON. Turn off "Streaming".',
  'background.check.streamNoDone':
    'Streaming output was complete, but only finish_reason arrived, with no [DONE] event ({count} partial results). Turn off "Streaming" if output gets cut off.',
  'background.check.streamOk':
    'Streaming works (received the {end} end event, {count} partial results).',
  'background.check.streamRejected':
    'The service does not accept streaming requests. Turn off "Streaming".',
  'background.check.streamInterrupted':
    'The streaming response did not end properly (missing end event or dropped connection). Consider turning off "Streaming".',
  'background.check.streamFailed': 'Streaming test failed: {message}',
  'background.check.authListButTranslateFailed':
    'The model list endpoint accepted this key, but the translation call failed, so it cannot be fully confirmed.',
  'background.check.authUnconfirmed':
    'Could not confirm the key on its own. See the model and translation results below.',
  'background.check.noProtocol':
    'The service supports neither the Responses nor the Chat Completions API. Make sure the Base URL is your sub2api API address.',
  'background.check.protocolUnsupported':
    'The service does not support the {protocol} API. Switch the protocol in Settings or use auto-detect.',
  'background.check.skippedAuthFailed': 'Not checked: authentication failed.',
  'background.check.translationAuthFailed': 'Translation test failed: authentication failed.',
  'background.check.modelForbidden':
    "No permission to use model {model} (403). Check the model permissions of the key's group, or choose another model.",
  'background.check.translationModelForbidden': 'Translation test failed: no access to the model.',
  'background.check.modelNotFound':
    'The service cannot find model {model}. Check the model ID spelling, or pick one from the model list.',
  'background.check.translationModelUnavailable':
    'Translation test failed: the model is unavailable.',
  'background.check.authAcceptedByTranslation':
    'The API key was accepted by the translation endpoint (it returned content).',
  'background.check.modelOutputInvalid':
    'Model {model} can be called, but its output failed validation.',
  'background.check.translationOutputInvalid':
    'The model\'s translation failed the format or language check. Try another model, or set the reasoning parameter to "Don\'t send" and retry.',
  'background.check.probeRejected':
    'The service rejected the probe request, so it cannot confirm whether the key works for translation.',
  'background.check.unconfirmedProbeRejected': 'Not confirmed: the probe request was rejected.',
  'background.check.translationRejected': 'Translation test failed: {message}',
  'background.check.unconfirmedNoResult':
    'Not confirmed: the translation test got no model result.',
  'background.check.translationFailed': 'Translation test failed: {message}',
  'background.coordinator.systemVoicesCount':
    '{count} system voices support the current target language (preview them to judge how they sound).',
  'background.coordinator.notProbed':
    'Checking sub2api {what} requires a real call (may incur a small charge). Tick "Allow real calls" and check again.',
  'background.coordinator.asrProbeOk':
    'The recognition endpoint call succeeded (the test audio is a 1-second synthetic tone, so this only verifies the endpoint and authentication, not accuracy{note}).',
  'background.coordinator.asrProbeEmptyNote': '; an empty transcript is expected',
  'background.coordinator.ttsProbeOk':
    'The synthesis endpoint returned {kb} KB of audio ({format}). Preview it on a video to judge the voice.',
  'background.coordinator.localAsrReady':
    'The local recognition service is available (model {model}, {device}). The pairing token will be verified on first use.',
  'background.coordinator.localAsrUnreachable':
    'Cannot connect to the local recognition service ({origin}). Make sure it is running.',
  'background.coordinator.hostPermissionRevoked':
    'Access to the service was revoked, so translation, capture and dubbing have stopped. Grant access again in Settings, then click "Start translation".',
  'background.coordinator.workerRestartedPaused':
    'The extension restarted in the background, so the paused translation cannot resume automatically. Click "Start translation" to start again; saved transcripts are not affected.',
  'background.coordinator.movedToOtherTab':
    'Translation moved to another tab and has stopped on this page.',
  'background.coordinator.otherTabNotStopped':
    'Translation in another tab did not stop in time, so this one was not started to avoid duplicate audio and requests. Close or reload the other tab, then try again.',
  'background.coordinator.startRetriesExhausted':
    'Translation failed to start after several attempts and has stopped. Reload the page and start again; if this keeps happening, check the service settings.',
  'background.coordinator.offscreenLost':
    'The audio processing component stopped unexpectedly, so speech recognition has stopped. Start translation again.',
  'background.coordinator.noActiveSession': 'There is no translation running in this tab.',
  'background.coordinator.sourceTabUnavailable':
    'The source video tab is unavailable, so it cannot jump there.',
  'background.coordinator.stateChanged':
    'The translation state changed and the view was refreshed. Check it and try again.',
  'background.coordinator.notYoutubeVideoTab':
    'This tab is not a playable YouTube video page, or the page is not connected yet. Open a video page and try again (reload it if needed).',
  'background.coordinator.noActiveSessionStart':
    'There is no translation running in this tab. Click "Start translation".',
  'background.coordinator.invalidSettings': 'Invalid setting value; it was not applied.',
  'background.coordinator.systemVoicesNone':
    'No system voice supports the current target language, so dubbing is unavailable and only subtitles will be shown.',
  'background.coordinator.configBecameInvalid':
    'The service settings changed and are now incomplete (URL, key, protocol, model or access permission missing), so translation has stopped. Finish the settings and start again.',
  'background.coordinator.emptyKey': 'The API key cannot be empty.',
  'background.coordinator.needBaseUrlSub2api': 'Enter a valid sub2api service URL first.',
  'background.coordinator.needApiKey': 'Enter an API key first.',
  'background.coordinator.needModelId': 'Enter a model ID first.',
  'background.coordinator.noHostPermission': 'Access to the service URL has not been granted.',
  'background.coordinator.asrNotEnabled':
    'No speech recognition service is enabled; videos without subtitles cannot be translated.',
  'background.coordinator.localAsrUrlInvalid': 'The local recognition service URL is invalid.',
  'background.coordinator.localAsrNoPermission':
    'Access to the local recognition service has not been granted.',
  'background.coordinator.unknownModel': 'unknown',
  'background.coordinator.unknownDevice': 'unknown device',
  'background.coordinator.localAsrNoToken':
    'The local recognition service is online, but no pairing token has been entered.',
  'background.coordinator.localAsrLoading':
    'The local recognition service is loading its model. Try again shortly.',
  'background.coordinator.saveKeyAndModelFirst':
    'Save an API key and a translation model in Settings first.',
  'background.coordinator.grantHostPermissionInSettings':
    'Grant access to the service URL in Settings first.',
  'background.coordinator.needValidBaseUrl': 'Enter a valid service URL first.',
  'background.coordinator.grantHostPermission': 'Grant access to the service URL first.',
  'background.coordinator.dubbingActive':
    'Dubbing is playing, so a preview is not available right now. Pause translation first.',
  'background.coordinator.previewNotStarted':
    'The system voice did not start speaking. Check the selected voice.',
  'background.coordinator.secretCleanupIncomplete':
    'The credential is no longer used, but copies in local storage have not all been removed. Click "Retry cleanup"; do not treat it as fully deleted until cleanup finishes.',
  'background.coordinator.checkReplaced': 'This check was replaced by a newer one.',
  'background.coordinator.checkSuperseded':
    'The settings changed, so this check result is void. Check again.',
  'background.coordinator.discoverySuperseded':
    'The service URL, key or access permission changed, so this model list is void. Load it again.',
  'background.coordinator.discoveryReplaced': 'This request was replaced by a newer one.',
  'background.coordinator.asrWhat': 'speech recognition',
  'background.coordinator.ttsWhat': 'speech synthesis',
  'background.coordinator.unknownFormat': 'unknown format',
  'background.session.dubError': 'Dubbing error: {message}',
  'background.session.statusBuffering': 'Buffering translation · {seconds}s',
  'background.session.translationBlocked': 'Stopped sending translation requests: {message}',
  'background.session.rateLimited': 'Rate limited by the service; retrying in about {seconds}s.',
  'background.session.translationFailing': 'Some subtitles failed to translate: {message}',
  'background.session.liveUnsupported':
    'Live streams are not supported yet: their subtitle and audio timing has not been verified. Use a regular (non-live) video.',
  'background.session.shortsUnverified':
    'Shorts pages have not been verified; subtitle position and timing may be off.',
  'background.session.partialCaptionsBuffered':
    'The full subtitle track cannot be read; only part of the subtitles is available. Switch the playback mode to "Continuous" in Settings to translate subtitles as they appear. To keep "Sync first", set the subtitle source to "Recognize speech when missing" and set up a local recognition service that supports audio preloading.',
  'background.session.bridgeNotReadyCaptionsOnly':
    'The page subtitle hook is not ready yet (the player may still be loading), so subtitles cannot be read right now. Try again shortly.',
  'background.session.bridgeNotReadyNoAsr':
    'The page subtitle hook is not ready yet (the player may still be loading), and no speech recognition service is set up. Try again shortly; the video keeps playing normally.',
  'background.session.noCaptions':
    'This video has no readable subtitles. In Settings, set the subtitle source to "Recognize speech when missing" and set up a speech recognition service.',
  'background.session.missingBaseUrl': 'No sub2api service URL is set. Enter it in Settings first.',
  'background.session.missingApiKey': 'No API key yet. Enter it in Settings.',
  'background.session.missingModel': 'No translation model selected.',
  'background.session.missingHostPermission':
    'Access to the sub2api service URL has not been granted. Click "Grant access" in Settings.',
  'background.session.protocolUndetermined':
    'Could not detect the API protocol automatically. Run "Check connection" in Settings or pick a protocol manually.',
  'background.session.trackLoadTimeout': 'Timed out reading the subtitle track',
  'background.session.incrementalCaptions':
    'The full subtitle track cannot be read, so the subtitles shown by the player are used instead. This only covers what has played, and YouTube subtitles must stay on.',
  'background.session.preloadLocalRequired':
    'Without a full subtitle track, "Sync first" needs a local recognition service with audio preloading. You can also switch to "Continuous".',
  'background.session.bufferPreparing':
    'Preparing the translation; playback follows the video once buffering finishes.',
  'background.session.bufferSegmentFailed':
    'Translating this part failed. Retry the failed items or switch to Continuous.',
  'background.session.bufferCannotPreload':
    'This source cannot be read ahead. Set up audio preloading or switch to Continuous.',
  'background.session.bufferReady':
    'Translation is buffered; later parts keep being prepared during playback.',
  'background.session.captureFailed':
    "Cannot capture this tab's audio. On that YouTube tab, click the Tongting icon in the browser toolbar (or press Alt+T), then try again.",
  'background.session.asrNotConfigured':
    'This video has no readable subtitles and no speech recognition service is set up. Set one up under "Recognition & playback" in Settings, then try again. The video keeps playing normally.',
  'background.session.asrLocalUrlInvalid':
    'Invalid local recognition service URL; only http://127.0.0.1:<port> is allowed.',
  'background.session.asrTokenMissing': 'No pairing token for the local recognition service yet.',
  'background.session.asrNoHostPermission':
    'Access to the local recognition service has not been granted. Click "Grant access" in Settings.',
  'background.session.asrSub2apiConfig': 'The sub2api service URL or key is not set.',
  'background.session.asrModelMissing': 'No sub2api speech recognition model entered yet.',
  'background.session.offscreenLost':
    'The audio processing component stopped unexpectedly, so speech recognition has stopped. Start translation again.',
  'background.session.ttsDisabled':
    'No speech synthesis service is enabled; only subtitles are shown.',
  'background.session.captureLeaseExpired':
    'Audio capture stopped because the background lost contact. Start translation again.',
  'background.session.captureEnded':
    'Tab audio capture ended (permission may have been revoked or page audio is unavailable), so speech recognition has stopped. Start translation again.',
  'background.session.asrBacklog':
    'Speech recognition cannot keep up with playback, so some audio was skipped. Pause the video to let it catch up, or use a smaller model in the local recognition service.',
  'background.session.asrUnavailable':
    'The speech recognition service is temporarily unavailable (model not ready or service busy); some audio was not recognized.',
  'background.session.asrFailing':
    'Some audio failed to be recognized and was skipped. Check the speech recognition service.',
  'background.session.videoEnded':
    'The video ended, so audio capture and recognition have stopped.',
  'background.session.backfillUnsupported':
    'The whole video can only be translated when the full subtitle track is readable; the current source only covers what has played.',
  'background.session.statusBufferPaused': 'Buffering paused, see side panel',
  'background.session.statusPreparing': 'Preparing',
  'background.session.statusPaused': 'Translation paused',
  'background.session.statusBlocked': 'Translation stopped, see side panel',
  'background.session.statusRateLimited': 'Rate limited, retrying soon',
  'background.session.statusFailing': 'Some subtitles failed, retrying',
  'background.session.statusAsrRunning': 'Translating speech',
  'background.session.statusRunning': 'Translating',
  'background.session.saveTranscriptFailed':
    'Could not save the transcript; subtitles are only kept in memory this time.',
  'background.session.noDubVoice':
    'No dubbing voice is available for the target language, so only subtitles are shown.',
  'background.http.endpointUnsupported':
    'The service does not support this endpoint ({status}). Switch the protocol in Settings (Responses / Chat Completions).',
  'background.http.rateLimited': 'Too many requests (429). Retrying in about {seconds}s.',
  'background.http.requestRejected':
    'The service rejected this translation request ({status}); the rest will still be translated. If this persists, check the model and protocol settings.',
  'background.http.serverError':
    'The service is having trouble ({status}); it will retry automatically. If it keeps failing, check the sub2api upstream status.',
  'background.http.unexpectedStatus': 'The service returned an unexpected status ({status}).',
  'background.http.timeout':
    'The service did not respond within {seconds}s; it will retry automatically. If this keeps happening, increase the timeout in Settings.',
  'background.http.redirectBlocked':
    'The service returned a redirect. The request was stopped so the API key is not sent elsewhere; set the Base URL to the final API address.',
  'background.http.authInvalid':
    'The API key is invalid or expired (401). Enter the key again in Settings and retry.',
  'background.http.quota':
    'The service reports insufficient balance or quota. Check your balance and group quota in the sub2api dashboard, then retry.',
  'background.http.permission':
    "No permission to use this model or endpoint (403). Check the model permissions of the key's group, or choose another model.",
  'background.http.modelNotFound':
    'The service cannot find this model (404). Check the model ID spelling, or pick one from the model list again.',
  'background.http.endpointNotFound':
    'The service does not support this endpoint (404). Check the Base URL, or switch the protocol in Settings.',
  'background.http.requestTimeout': 'The service timed out (408); it will retry automatically.',
  'background.http.payloadTooLarge':
    'The request is too large (413). Reduce the number of subtitles per batch.',
  'background.http.rateLimitedNoRetryAfter':
    'Too many requests (429). Prefetching is paused and will retry shortly.',
  'background.http.modelIdRejected':
    'The service does not accept this model ID. Check the model name, or pick one from the model list again.',
  'background.http.unsupportedParameter':
    'The service does not accept an optional parameter in this request (reasoning or structured output). If a reasoning parameter is set, change it to "Don\'t send" and retry.',
  'background.http.contentRejected':
    "The service's content moderation rejected this subtitle, so it was skipped; the rest will still be translated.",
  'background.http.contextTooLong':
    "This batch exceeds the model's context length, so subtitles will be translated one by one.",
  'background.http.networkError':
    'Cannot connect to the service. Check your network, the Base URL and certificate, and make sure access to that address is granted.',
  'background.http.streamInterrupted':
    'The streaming response was cut off before it finished. The result was discarded and will be retried automatically.',
  'background.audioHttp.redirect':
    '{service} returned a redirect, which was not followed to protect your credentials. Check the service URL.',
  'background.audioHttp.timeout': '{service} timed out',
  'background.audioHttp.unreachable':
    'Cannot connect to {service}: the network may be down, the cross-origin request was refused, or the service tried to redirect (not followed).',
  'background.audioHttp.badRequest': '{service} rejected the request parameters (400)',
  'background.audioHttp.quota': '{service}: insufficient balance or quota.',
  'background.audioHttp.forbidden': 'This key cannot use {service} or the selected model (403).',
  'background.audioHttp.notFound':
    '{service} endpoint not found (404): the service may not support it, or the URL is wrong.',
  'background.audioHttp.requestTimeout': '{service} timed out while processing (408)',
  'background.audioHttp.audioTooLong': '{service} rejected audio that is too long (413)',
  'background.audioHttp.unsupportedMedia': '{service} does not accept this audio format (415)',
  'background.audioHttp.quota429': '{service}: quota exhausted (429).',
  'background.audioHttp.rateLimited': '{service} is busy or rate limited (429); retrying later.',
  'background.audioHttp.serverError': '{service} server error ({status})',
  'background.audioHttp.unexpectedStatus': '{service} returned an unexpected status ({status})',
  'background.audioHttp.localUrlInvalid':
    'Invalid local recognition service URL; it should be http://127.0.0.1:<port>',
  'background.audioHttp.localUrlNotLoopback':
    'The local recognition service URL must be http://127.0.0.1:<port> (localhost is not supported)',
  'background.audioHttp.localUrlExtras':
    'The local recognition service URL cannot contain credentials, a query or a fragment',
  'background.audioHttp.baseUrlInvalid': 'Invalid sub2api URL',
  'background.audioHttp.baseUrlInsecure':
    'The sub2api URL must use HTTPS (except local development addresses)',
  'background.audioHttp.baseUrlExtras':
    'The sub2api URL cannot contain credentials, a query or a fragment',
  'background.audioHttp.bodyTooLarge': 'The service returned too much data',
  'background.audioHttp.cancelled': 'Cancelled',
  'background.audioHttp.localUnreachable':
    'Cannot connect to the local recognition service. Make sure it is running at http://127.0.0.1:<port> and that the extension has access to http://127.0.0.1.',
  'background.audioHttp.preloadUnavailable':
    'The local recognition service has audio preloading off or is missing dependencies. Start it with --youtube-preload and make sure yt-dlp, ffmpeg and Node.js are installed, or switch to "Continuous".',
  'background.audioHttp.preloadUnsupportedVideo':
    'This video does not support audio preloading (it may be live, restricted or have no usable audio). Use a regular public video, or try "Continuous" for recorded videos.',
  'background.audioHttp.preloadPastEnd':
    'The preload position is past the end of the video. Seek back into the video and retry.',
  'background.audioHttp.preloadAudioFailed':
    'Cannot read the video audio. Check video access, your network or proxy and retry, or switch to "Continuous".',
  'background.audioHttp.preloadTimeout':
    'Audio preloading timed out. Check your network or proxy and retry, or switch to "Continuous".',
  'background.audioHttp.localLanguageUnsupported':
    'The local recognition service does not support the selected language. Choose "Auto-detect" or another language.',
  'background.audioHttp.localTokenInvalid':
    'The local recognition service pairing token is invalid. Pair again in Settings.',
  'background.audioHttp.keyInvalid': 'The API key is invalid or expired. Check it in Settings.',
  'background.audioHttp.localForbidden':
    'The local recognition service refused the request (403). Use an http://127.0.0.1:<port> address and make sure the request comes from the extension.',
  'background.audioHttp.localModelLoading': 'The local recognition model is loading. Please wait.',
  'background.audioHttp.localModelUnavailable':
    'The local recognition model is unavailable. Check the service logs or restart the service.',
  'background.audioHttp.localUnavailable':
    'The local recognition service is temporarily unavailable (503).',
  'background.audioHttp.serviceLocalAsr': 'Local recognition service',
  'background.audioHttp.serviceSub2apiAsr': 'sub2api speech recognition',
  'background.audioHttp.serviceSub2apiTts': 'sub2api speech synthesis',
  'background.errors.cancelled': 'Cancelled',
  'background.errors.internal':
    'An internal error occurred. Try again; if it keeps happening, check the extension logs.',
  'background.baseUrl.empty':
    'Enter your sub2api service URL (Base URL), e.g. https://api.example.com.',
  'background.baseUrl.tooLong': 'The service URL is too long. Enter only the API root address.',
  'background.baseUrl.whitespace':
    'The service URL contains whitespace. Check it and enter it again.',
  'background.baseUrl.noScheme':
    'The service URL must start with https://, e.g. https://api.example.com.',
  'background.baseUrl.invalid':
    'Invalid service URL. Enter an address like https://api.example.com.',
  'background.baseUrl.scheme':
    'Only https:// service URLs are supported (http://127.0.0.1 is allowed for local debugging).',
  'background.baseUrl.noHost': 'The service URL has no host name. Check it and enter it again.',
  'background.baseUrl.credentials':
    'The service URL cannot contain a user name or password. Enter the API key in the "API key" field.',
  'background.baseUrl.query':
    'The service URL cannot contain a query (anything after ?). Enter only the API root address.',
  'background.baseUrl.fragment':
    'The service URL cannot contain a # fragment. Enter only the API root address.',
  'background.baseUrl.hostInvalid':
    'Invalid host name in the service URL. Enter a specific domain or IP without wildcards like * or encoded characters.',
  'background.baseUrl.insecure':
    'To protect your API key, the service URL must use https://; http is only allowed for the local debugging address 127.0.0.1.',
  'background.protocol.truncated':
    'The model output was cut off. This batch was discarded and will be retried in smaller batches.',
  'background.protocol.refused':
    'The model refused to translate this subtitle. It is marked as failed; retry later or switch models.',
  'background.protocol.empty': 'The model returned no translation. You can retry later.',
  'background.protocol.rateLimited':
    'Too many requests (the service reported rate limiting). Prefetching is paused and will retry shortly.',
  'background.protocol.quota':
    'The service reports insufficient balance or quota. Check your balance and group quota in the sub2api dashboard, then retry.',
  'background.protocol.serverError':
    'The service returned an error while processing; it will retry automatically.',
  'background.cache.emptyValue': 'An empty translation cannot be cached.',
  'background.cache.tooLarge': 'The translation is too long and was not cached.',
  'background.cache.readFailed':
    'Could not read the translation cache; translating directly instead.',
  'background.cache.writeFailed':
    'Could not write the translation cache; this translation is still usable.',
  'background.cache.clearFailed': 'Could not clear the translation cache. Try again.',
  'background.cloudTts.notConfigured':
    'The cloud dubbing service is not set up (URL, key, model), so dubbing is unavailable; subtitles still work.',
  'background.cloudTts.failed': 'Cloud dubbing failed',
  'background.cloudTts.disposed': 'The dubbing engine has been released',
  'background.cloudTts.noOwner': 'There is no session that can play dubbing right now',
  'background.cloudTts.requestFailed': 'Cloud dubbing request failed',
  'background.textProvider.apiKeyMissing':
    'No API key yet. Enter it in Settings before starting translation.',
  'background.textProvider.modelMissing':
    'No model selected. Choose one in Settings or enter a model ID.',
  'background.textProvider.protocolInvalid': 'The protocol must be Responses or Chat Completions.',
  'background.textProvider.batchInvalidIds':
    'The translation batch has empty or duplicate subtitle IDs.',
  'background.textProvider.outputInvalid':
    "The model's translation failed validation (missing or duplicate subtitle IDs, or bad format). This batch is marked as failed; retry later.",
  'background.sub2apiAsr.noKey': 'No API key set',
  'background.sub2apiAsr.noModel': 'No speech recognition model selected',
  'background.sub2apiAsr.segmentTooLarge': 'The recognition segment is too large',
  'background.sub2apiAsr.noHealthCheck':
    'sub2api speech recognition has no free health check; run an explicit (possibly billed) recognition test in the connection check.',
  'background.sub2apiAsr.badResponse':
    'sub2api speech recognition returned data in an unrecognized format',
  'background.scheduler.noValidTranslation': 'The model returned no valid translation.',
  'background.scheduler.cueNoValidTranslation':
    'The model returned no valid translation for this subtitle (after a limited repair). You can retry later.',
  'background.scheduler.unexpectedAbort':
    'The request was aborted unexpectedly (not by pausing or seeking); it will retry automatically.',
  'background.scheduler.circuitOpen':
    '{count} translation requests in a row returned no valid translation, so sending is paused to avoid wasting quota. Check the model or service status, then click "Retry".',
  'background.dubbing.speakFailed': 'Dubbing failed to start speaking',
  'background.dubbing.voicesUnavailable': 'Cannot read the list of available dubbing voices',
  'background.dubbing.stalled':
    'The dubbing engine did not start speaking in time, so this line was skipped.',
  'background.dubbing.noVoice':
    'No dubbing voice is available for "{language}", so dubbing is unavailable; subtitles still work. You can switch to another dubbing service in Settings.',
  'background.search.invalidOutput':
    'The model did not return a valid result (a literal translation first, then two short search terms, in the selected search language). Generate again.',
  'background.search.notConfigured': 'Save an API key and a translation model in Settings first.',
  'background.search.rejected':
    'The service rejected the search term request. Check the model and protocol in Settings.',
  'background.textHttp.failed': 'The request failed. Try again.',
  'background.textHttp.originMismatch':
    'The request address does not match the configured service URL, so it was not sent.',
  'background.textHttp.bodyTooLarge': 'The service response is too large; reading stopped.',
  'background.textHttp.notJson':
    'The service did not return valid JSON. Make sure the Base URL points to the API root, not a web page.',
  'background.localAsr.notPaired': 'Not paired with the local recognition service yet',
  'background.localAsr.segmentTooLarge':
    'The recognition segment exceeds the local service size limit',
  'background.localAsr.badResponse':
    'The local recognition service returned data in an unexpected format',
  'background.localAsr.healthFailed': 'Local recognition health check failed',
  'background.preload.needVideoAndPairing':
    'Audio preloading needs a valid YouTube video and local recognition pairing.',
  'background.preload.needUpdate':
    'The local recognition service needs to be updated with audio preloading enabled. You can also switch to "Continuous".',
  'background.preload.badRange':
    'Audio preloading returned an invalid time range, so it stopped to avoid misaligned subtitles.',
  'background.recognition.encodeFailed': 'Failed to encode audio for recognition',
  'background.recognition.stalled': 'A speech recognition request took too long and was aborted.',
  'background.recognition.failed': 'Speech recognition failed',
  'background.sub2apiTts.noAudio': 'sub2api speech synthesis returned no audio data',
  'background.sub2apiTts.emptyAudio': 'sub2api speech synthesis returned empty audio',
  'background.textFormat.responsesUnrecognized':
    'The service returned a Responses result in an unrecognized format.',
  'background.textFormat.streamEventInvalid':
    'The streaming response contained an unparseable event; this result was discarded.',
  'background.textFormat.chatUnrecognized':
    'The service returned a Chat Completions result in an unrecognized format.',
  'background.rpc.timeout': 'The page or a background component did not respond in time',
  'background.rpc.disconnected': 'Connection lost',
  'background.preload.failed': 'Audio preloading failed. Retry or switch to "Continuous".',
  'background.systemTts.failed':
    'The system voice failed to speak. Try another voice or switch to subtitles only.',
  'background.textHttp.streamTooLarge': 'The streaming response is too large; reading stopped.',
  'background.models.unrecognized':
    'The model list returned by the service is in an unrecognized format. Enter a model ID manually.',
  'background.search.tooMany': 'Several searches are already being generated. Try again shortly.',
  'background.connections.invalidCommand': 'Invalid command format; rejected',
  'background.offscreen.ttsStopped':
    'This dubbing line was already stopped; the late play request was ignored.',
  'background.offscreen.ttsDecodeFailed': 'Cannot decode the cloud dubbing audio',
  'background.offscreen.ttsPlayFailed': 'Cloud dubbing playback failed',
  'background.offscreen.captureDenied':
    'The browser denied tab audio capture. Click the extension button on the video page, then start again.',
  'background.offscreen.captureFailed':
    'Cannot capture the tab audio (the capture ID may have expired or the tab cannot be captured). Start again.',
  'background.offscreen.noAudioTrack': 'The captured tab stream has no audio track',
  'background.offscreen.audioSetupFailed':
    'Cannot set up audio processing (AudioContext/AudioWorklet)',
  'background.offscreen.asrConfigInvalid': 'Invalid speech recognition settings',
  'background.offscreen.contextClosed':
    'The audio processing context closed unexpectedly, so recognition has stopped. Start again.',
  'background.offscreen.captureEnded':
    'Tab audio capture ended (tab closed, navigated away or permission revoked). Start again.',
  'background.offscreen.inputQuiet':
    'The captured video audio is too quiet and keeps being treated as silence, so it is not sent for recognition. Turn up or unmute the YouTube player.',
  'background.offscreen.notRunning': 'Audio capture is not running',
  'background.offscreen.leaseMismatch':
    'The audio capture lease has expired or belongs to another session. Start again.',
  'background.offscreen.leaseExpired':
    'The background did not confirm the audio session for too long, so capture stopped automatically.',
  'background.offscreen.unresponsive':
    'The audio processing document did not respond to the handshake',
  'background.offscreen.notConnected': 'The audio processing document is not connected',
  'background.offscreen.disconnected': 'Lost connection to the audio processing document',
  'background.offscreen.createFailed': 'Cannot create the audio processing document (offscreen)',
  'background.offscreen.missing': 'The audio processing document does not exist',
  'background.offscreen.reconnected':
    'The audio processing document reconnected; earlier requests were discarded',
  'background.offscreen.badRequest': 'Invalid audio processing request',
  'background.offscreen.apiUnavailable': 'The offscreen API is not available in this environment',
  'background.offscreen.disconnectedReason':
    'Lost connection to the audio processing document ({reason})',
  'background.offscreen.timeout': 'Audio processing request timed out ({kind})',
  'background.youtube.staleVideo':
    'The video on the page changed; the earlier request was ignored.',
  'background.youtube.navigationChanged':
    'The page switched to another video, so the action was cancelled.',
  'background.youtube.playerUnavailable':
    'No video player found on the page. Wait for the video to load and try again.',
  'background.youtube.adPlaying': 'An ad is playing. Try again once the video starts.',
  'background.youtube.noTracks': 'This video has no readable subtitle tracks.',
  'background.youtube.trackNotFound':
    'The requested subtitle track was not found; it may no longer apply after the video changed.',
  'background.youtube.loadTimeout':
    'Loading the subtitle track timed out: the player returned no readable subtitles. Use the on-screen subtitles or speech recognition instead.',
  'background.youtube.parseFailed':
    'The subtitle format is not recognized, so the full track cannot be read.',
  'background.youtube.captionsPlayerUnavailable':
    "Cannot read the player's subtitle info right now. Try again shortly.",
  'background.youtube.bridgeUnavailable':
    'The page subtitle hook is not ready. Reload the YouTube page and try again.',
  'background.youtube.duckFailed': 'Cannot adjust the original audio volume.',
  'background.youtube.internal':
    'An internal error occurred on the page. Reload the page and try again.',
  'background.overlay.phase.idle': 'Not started',
  'background.overlay.phase.configuring': 'Setup needed',
  'background.overlay.phase.starting': 'Preparing',
  'background.overlay.phase.running': 'Running',
  'background.overlay.phase.pausing': 'Pausing',
  'background.overlay.phase.paused': 'Paused',
  'background.overlay.phase.stopping': 'Stopping',
  'background.overlay.phase.error': 'Error',
  'background.overlay.badge': 'Tongting · {label}',
};

export const background = { 'zh-CN': zhCN, en };
