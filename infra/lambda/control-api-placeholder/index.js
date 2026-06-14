// 制御 API のプレースホルダ (フェーズ1)。
// フェーズ2で services/control-api の実ハンドラ資産に差し替える。
exports.handler = async () => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ok: true, message: "stagecast control-api placeholder" }),
});
