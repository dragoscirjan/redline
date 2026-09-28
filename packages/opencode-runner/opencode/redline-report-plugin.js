const PREFIX = 'REDLINE_REVIEW_TEXT_DELTA ';
const MAX_TRACKED_PARTS = 1024;

function partKey(sessionID, partID) {
  return `${sessionID}\0${partID}`;
}

export const RedlineReportPlugin = async () => {
  const partTypes = new Map();

  return {
    event: async ({ event }) => {
      if (process.env.REDLINE_REPORT_EVENTS !== '1') return;

      if (event?.type === 'message.part.updated') {
        const part = event.properties?.part;
        if (typeof part?.sessionID !== 'string' || typeof part?.id !== 'string' || typeof part?.type !== 'string') return;
        const key = partKey(part.sessionID, part.id);
        if (!partTypes.has(key) && partTypes.size >= MAX_TRACKED_PARTS) {
          const oldest = partTypes.keys().next().value;
          if (oldest !== undefined) partTypes.delete(oldest);
        }
        partTypes.set(key, part.type);
        return;
      }

      if (event?.type === 'message.part.removed') {
        const properties = event.properties;
        if (typeof properties?.sessionID === 'string' && typeof properties?.partID === 'string') {
          partTypes.delete(partKey(properties.sessionID, properties.partID));
        }
        return;
      }

      if (event?.type !== 'message.part.delta') return;
      const properties = event.properties;
      if (
        typeof properties?.sessionID !== 'string' ||
        typeof properties?.partID !== 'string' ||
        properties.field !== 'text' ||
        typeof properties.delta !== 'string' ||
        partTypes.get(partKey(properties.sessionID, properties.partID)) !== 'text'
      ) {
        return;
      }
      const payload = {
        version: 1,
        sessionID: properties.sessionID,
        messageID: properties.messageID,
        partID: properties.partID,
        delta: properties.delta,
      };
      process.stdout.write(`${PREFIX}${JSON.stringify(payload)}\n`);
    },
  };
};
