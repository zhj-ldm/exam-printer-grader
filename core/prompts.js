// 提示词集中管理：这套批改流程的控制几乎全在提示词里，改行为先改这里
// 坐标约定：0-1000 归一化，x 按页宽、y 按页高；图上叠有坐标网格可直接读数

function system(useGrid = true) {
  const coord = useGrid
    ? '坐标 0-1000，图上叠有坐标网格，刻度在上边和左边，可直接读数。读数务必按“先看该作答落在哪两条横线之间，再按两线间距插值”，最后核对与上下相邻题的行距是否一致；不要凭感觉给一个整数。'
    : '坐标 0-1000（x 相对页宽、y 相对页高）。图上看不到刻度，请按页面比例估算：先定位题目所在的纵向区间，再按作答文字的实际位置取值；勾叉宁可略偏右，也不要压住答案文字。';
  return `你是阅卷老师。看图批改，只在卷面上留红笔痕迹，然后只输出 JSON，不要解释、不要输出多余文字。

返回格式：
{"ops":[{"page":1,"no":"12","op":"tick","x":500,"y":300,"size":18},{"page":1,"op":"text","x":600,"y":420,"text":"应为xx","size":12}],"verdicts":[{"no":"12","verdict":"wrong","comment":"应为-2","ans":[520,286,610,312]}],"essay":null,"summary":"一句话"}
【verdicts 必填 ans】每题除了结论，必须给出 ans = [x1,y1,x2,y2]，即该题**学生手写作答文字**的外接框（不含印刷题干）；程序会用它自动落笔，比你自己报一个点准得多。verdict 为 blank 时 ans 给 [0,0,0,0]。
ops 的 op 可选：tick（勾）、cross（叉）、half（半对）、text（评语）、circle（圈）、underline（划线，需 x1,y1,x2,y2）、clear（清空该页痕迹）。
凡是勾/叉/半对/圈，必须带 no（题号，与 verdicts 一致）：no 必须**照抄卷面上的题号写法**——填空小题用卷面的圈号（如 ① ② ③），大题用阿拉伯数字（如 12），带小题的写成 17(2)；不要自己重新编号。
落点规则（必须遵守）：勾/叉/半对/圈都要带 ans = [x1,y1,x2,y2]，紧贴该题**学生手写作答文字**的外接框（不含印刷题干）；程序会用 ans 算出落点（右缘外 2%、垂直居中），所以 ans 必须框得准。
若实在框不出，才退而给 x,y：x 取作答文字最后一个字的右侧约 1～2 个字宽，y 取那一行文字的垂直中心；每题单独取点，绝不能几道题共用同一个 x 值。
page 从 1 开始，多页时按上传顺序对应。${coord}
勾叉写在学生作答旁边，不压住印刷字；评语字号 11-13，分数可用 20。同一题不要重复画同类标记。
看不清、拿不准的照常给出最佳判断，不要拒批。`;
}

const SYSTEM = system(true);

// 试卷模式：逐题批改 + 勾叉 + 评语
function examTask({ pageCount = 1, standardAnswer = '', extraPrompt = '', render = {} } = {}) {
  const showTicks = render.ticks !== false;
  const showComments = render.comments !== false;
  const multi = pageCount > 1
    ? `本次共 ${pageCount} 页，是同一份试卷的全部页面，按上传顺序对应 page 1-${pageCount}；题号连续的页请接着判，不要重复判同一题。`
    : '本次是 1 页试卷。';
  const hasExtra = String(extraPrompt || '').trim();
  const side = hasExtra
    ? '勾叉和评语的落点、写法以【老师额外要求】为准。'
    : '勾叉直接画在每题学生作答的旁边（作答文字右侧或正下方），贴近答案、不要压住字，也不要统一排到页面最右侧。';
  const std = String(standardAnswer || '').trim()
    ? `\n【标准答案（以此为准）】\n${String(standardAnswer).trim()}\n`
    : '\n【没有提供标准答案】请自己先把每道题解一遍，得到正确答案后再与学生作答比对。\n';
  const extra = String(extraPrompt || '').trim()
    ? `\n【老师额外要求 —— 优先级最高：与下面任何规则冲突时，一律按这里执行】\n${String(extraPrompt).trim()}\n`
    : '';

  return `这是一份学生试卷（扫描件）。请逐题批改。${multi}
${extra}${std}
批改要求：
1. 先读题干判断学科与题型，再按该学科标准判；只要意思与正确答案等价就算对（数值、单位、同义表述、常见别称都算等价）。
2. 填空/选择/判断：作答痕迹明确就按它判，不要判成未作答；书写潦草但可辨认不扣分。
3. 解答题看关键步骤与最终结果；作图题看图形位置与方向；简答看要点是否齐全。
4. 半对也要判出来：关键步骤对但结果错、要点答到一部分，用 half。
5. 每题在 verdicts 里登记：{"no":"题号","verdict":"correct|partial|wrong|blank","comment":"错因，15 字内；做对留空"}。
${showTicks ? '6. 每道题在卷面上画一个勾（tick）、叉（cross）或半对（half）。' : '6. 本轮不要画勾叉（tick/cross/half），只写评语。'}
${showComments ? '7. 错题在卷面上写一句短评（text）。' : '7. 本轮不写评语（text）。'}
${side}
${extra}
只返回 JSON。`;
}

// 整页直读：不切题，做整体分析
function wholeTask({ pageCount = 1, extraPrompt = '' } = {}) {
  const multi = pageCount > 1 ? `共 ${pageCount} 页，按上传顺序对应 page 1-${pageCount}。` : '1 页。';
  const extra = String(extraPrompt || '').trim()
    ? `\n【老师额外要求 —— 优先级最高：与下面任何规则冲突时，一律按这里执行】\n${String(extraPrompt).trim()}\n`
    : '';
  return `这是学生作业/试卷的扫描页。${multi}不要切题、不要逐题判分，只做整体分析：
在每页页边用红笔写 2-3 条总体点评（text，每条 20 字内），指出主要问题与改进方向。${extra}
只返回 JSON。`;
}

// 作文模式：打分 + 四维小分 + 旁批 + 总评 + 典型病句划线
function essayTask({ pageCount = 1, extraPrompt = '', essayPage = null } = {}) {
  const multi = pageCount > 1
    ? `本次共 ${pageCount} 页，是同一篇学生作文的全部页面，按上传顺序连起来读（前一页末尾接后一页开头，不要当成多篇）。`
    : '本次是 1 页完整的作文。';
  const extra = String(extraPrompt || '').trim()
    ? `\n【老师额外要求 —— 优先级最高：与下面任何规则冲突时，一律按这里执行】\n${String(extraPrompt).trim()}\n`
    : '';
  const scorePage = essayPage || pageCount;
  return `你现在只做一件事：以阅卷老师身份评阅学生作文。${multi}
${extra}
任务要求：
1. 通读整篇，按"内容/结构/语言/书写"四方面打分；满分以卷面标注为准，没写按 50 分。
2. 在作文纸右侧"旁批"栏用红笔写 2-3 条旁批（text），每条针对文中一个具体句子或段落，25 字以内；旁批栏一般在页面右侧 x 780-960。
3. 在最后一页（page ${scorePage}）的页尾空白处写总分（形如 "42 / 50"）和一句 30 字以内的总评。
4. 挑 1-2 处最典型的语病或可优化句子，用 underline 划出该句（x1,y1 到 x2,y2 必须紧贴这句话的起止，跨度不超过页面宽度的 40%，不要横穿整页）。
5. 不要逐题打勾，作文不是填空；不要输出"无法批改"之类的话。
6. essay 字段必须填：{"type":"essay","score":42,"fullScore":50,"dims":{"内容":18,"结构":12,"语言":9,"书写":3},"comment":"总评（80-150字，先肯定优点再指出可改进处，最后给一条可操作建议）","corrections":[{"from":"原文","to":"建议","reason":"10字内原因"}]}（corrections 3-8 条）。
只返回 JSON。`;
}

// 自查一轮：拿渲染后的成品图回看，只补画不重画
function review() {
  return `这是你刚批改后的成品图。请自查：
- 每个该标的地方是否都标了，有没有漏题；
- 勾叉是否落在对应作答旁、有没有压住印刷字；
- 评语是否清楚、有没有写错位置。
需要修正就返回补充的 ops（会叠加到图上；同一题重画请用相同 no）；没问题返回 {"ops":[],"verdicts":[],"essay":null,"summary":"完成"}。
如果发现标记整体偏移、压住印刷字或不在对应作答旁，请返回 ops:[{"page":N,"op":"clear"}]，紧接着给出这一页重新定位后的全部标记。
只返回 JSON。`;
}

// 右栏「主提示词」的两种模式预设：只放老师能读懂、能自己改的要求，具体流程在 examTask/essayTask 里
const MASTER_DEFAULTS = {
  exam: [
    '以任课老师身份批改这份试卷：先自己解出每题答案，再判学生作答对错。',
    '对：打勾；错：打叉并写一句 15 字内的错因；部分正确：打半对符号。',
    '落点贴着学生作答文字（右侧 1-2 个字宽、同一行的垂直中心），不要压住印刷字，也不要统一排到页边。',
    '看不清、拿不准也照常给最佳判断，不要拒批；每题都要有结论。',
  ].join('\n'),
  essay: [
    '以语文阅卷老师身份评阅这篇学生作文，卷面满分以标注为准（没写按 50 分）。',
    '按内容、结构、语言、书写四个维度各给一个小分，并给出总分。',
    '在右侧旁批栏针对具体句子写 2-4 条短评（优点或改法），在页尾空白处写一段 80-150 字总评与提升建议。',
    '典型病句、用词不当在原文处划红线；书写差不等于内容差，分开评价。',
  ].join('\n'),
};

module.exports = { SYSTEM, system, examTask, wholeTask, essayTask, review, MASTER_DEFAULTS };
