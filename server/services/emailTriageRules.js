// Model output needs support in the current message, not just an allowed category name.
function normalize(text) {
  return String(text || '').normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

function currentBody(reply) {
  return String(reply.clean_body_text || reply.body_text || '')
    .split(/\n\s*(?:>|On\b[^\n]*wrote:|From:|发件人[:：]|-{5,}|_{5,})/i)[0].trim();
}

function hasPaymentIssue(text) {
  const value = normalize(text);
  // A settled payment, a gifted collaboration or a paid partnership is not itself a payment issue.
  return value.split(/(?<=[.!?。！？;；])\s*/u).some(sentence => {
    if (/(?:no|without)\s+(?:payment|billing)\s+(?:issue|problem)|payment\s+(?:has been |was |is )?(?:received|settled)|已(?:经)?(?:收款|到账)|付款(?:无异常|没有问题)/i.test(sentence)) return false;
    const money = /\b(?:payment|invoice|refund|payout|remittance|bank transfer|commission|balance|money|compensation)\b|\b(?:pay|paid)\s+(?:me|us)\b|\b(?:been|get|be) paid\b|付款|支付|催款|结算|报酬|尾款|退款|佣金|发票|款项|到账|[$€£]\s*\d/i.test(sentence);
    const issue = /\b(?:overdue|unpaid|outstanding|failed|missing|pending|incorrect|wrong|remind|reminder|owed)\b|(?:not|haven't|hasn't|never)\s+(?:yet\s+)?received|(?:not|haven't|hasn't) been paid|waiting to be paid|逾期|未付|没付|未收到|没收到|未到账|未结|失败|异常|错误|催款/i.test(sentence)
      || /\b(?:when|where|status|update)\b.{0,60}\b(?:payment|payout|refund|remittance|paid)\b|\b(?:payment|payout|refund)\b.{0,40}\b(?:status|update)\b|\b(?:please|could you|can you|kindly)\b.{0,40}\b(?:pay|settle|refund)\b|\b(?:please|could you|can you|kindly)\b.{0,30}\b(?:send|process|release|transfer)\b.{0,30}\b(?:payment|money|refund|payout|balance)\b|(?:何时|什么时候|能否|请).{0,25}(?:付款|支付|结算|打款|到账|退款)|(?:到账|付款|支付|结算|退款).{0,15}(?:进度|状态|何时|什么时候)/i.test(sentence);
    return money && issue;
  });
}

function isLogisticsRequest(text) {
  const value = normalize(text);
  return /\b(?:ship|shipped|shipping|shipment|tracking|delivery|parcel|package|dispatch)\b|发货|寄出|寄送|物流|运单|快递|包裹|收货|配送/i.test(value)
    && /\b(?:where|whether|could|please|when|can|check|send|share|provide|status|update|yet|has|have)\b|[?？]|请|能否|是否|何时|什么时候|查询|催发货|催物流|没收到|未收到|进度/i.test(value);
}

function validateClassification(parsed, reply) {
  const body = currentBody(reply);
  const issue = hasPaymentIssue(body);
  const logistics = isLogisticsRequest(body);
  const quote = normalize(parsed.payment_evidence);
  const paymentSupported = quote.length >= 4 && quote.length <= 500 && normalize(body).includes(quote) && hasPaymentIssue(quote);
  if (logistics && !issue) {
    // A valid execution classification may have deadline evidence in its history.
    // Preserve that reasoning and urgency rather than replacing it with a default.
    if (parsed.category === 'execution_issue') return parsed;
    return { ...parsed, category: 'execution_issue',
      priority: /\burgent\b|\basap\b|\btomorrow\b|紧急|今天|明天|马上/i.test(body) ? parsed.priority : 'important',
      reason: '本封来信询问寄送、发货或物流追踪信息，属于合作执行中的物流跟进；正文没有催款、付款失败或结算异常的证据。',
      action: '核对寄送和发货记录；已发货则提供承运商、运单号及查询链接，未发货则告知预计安排，并结合约定发布档期判断是否需要加急。' };
  }
  if (parsed.category === 'payment' && !paymentSupported) {
    return { ...parsed, category: 'needs_review', priority: 'important',
      reason: 'AI 给出了付款分类，但未提供能在本封正文中核验的催款、付款失败或结算异常原文，需人工确认。',
      action: '根据当前来信核对实际诉求；不要把历史报价、已收款或一般合作沟通直接当作催款。' };
  }
  return parsed;
}

module.exports = { currentBody, hasPaymentIssue, isLogisticsRequest, validateClassification };
