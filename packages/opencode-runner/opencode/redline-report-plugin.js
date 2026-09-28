const PREFIX = 'REDLINE_REVIEW_TEXT_DELTA ';

export const RedlineReportPlugin = async () => ({
  event: async ({ event }) => {
    if (process.env.REDLINE_REPORT_EVENTS !== '1') return;
    if (event?.type !== 'message.part.delta') return;
    const properties = event.properties;
    if (properties?.field !== 'text' || typeof properties.delta !== 'string') return;
    const payload = {
      version: 1,
      sessionID: properties.sessionID,
      messageID: properties.messageID,
      partID: properties.partID,
      delta: properties.delta,
    };
    process.stdout.write(`${PREFIX}${JSON.stringify(payload)}\n`);
  },
});
