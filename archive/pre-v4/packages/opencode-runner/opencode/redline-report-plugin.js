const DELTA_PREFIX = 'REDLINE_REVIEW_TEXT_DELTA ';
const END_PREFIX = 'REDLINE_REVIEW_TEXT_END ';
const MAX_TRACKED_PARTS = 1024;

function partKey(sessionID, partID) {
  return `${sessionID}\0${partID}`;
}

export const RedlineReportPlugin = async () => {
  const partTypes = new Map();
  const coordinatorAlias = process.env.REDLINE_COORDINATOR_SESSION_ID ?? 'redline-coordinator';
  let coordinatorSessionID;
  const isCoordinator = (sessionID) => {
    coordinatorSessionID ??= sessionID;
    return sessionID === coordinatorSessionID;
  };

  return {
    event: async ({ event }) => {
      if (process.env.REDLINE_REPORT_EVENTS !== '1') return;

      if (event?.type === 'message.part.updated') {
        const part = event.properties?.part;
        if (
          typeof part?.sessionID !== 'string' ||
          typeof part?.id !== 'string' ||
          typeof part?.type !== 'string' ||
          !isCoordinator(part.sessionID)
        ) return;
        const key = partKey(part.sessionID, part.id);
        if (!partTypes.has(key) && partTypes.size >= MAX_TRACKED_PARTS) {
          const oldest = partTypes.keys().next().value;
          if (oldest !== undefined) partTypes.delete(oldest);
        }
        partTypes.set(key, part.type);
        if (part.type === 'text' && part.time?.end !== undefined) {
          const payload = {
            version: 1,
            sessionID: coordinatorAlias,
            messageID: part.messageID,
            partID: part.id,
          };
          process.stdout.write(`${END_PREFIX}${JSON.stringify(payload)}\n`);
        }
        return;
      }

      if (event?.type === 'message.part.removed') {
        const properties = event.properties;
        if (
          typeof properties?.sessionID === 'string' &&
          typeof properties?.partID === 'string' &&
          properties.sessionID === coordinatorSessionID
        ) {
          partTypes.delete(partKey(properties.sessionID, properties.partID));
        }
        return;
      }

      if (event?.type !== 'message.part.delta') return;
      const properties = event.properties;
      if (
        typeof properties?.sessionID !== 'string' ||
        typeof properties?.partID !== 'string' ||
        properties.sessionID !== coordinatorSessionID ||
        properties.field !== 'text' ||
        typeof properties.delta !== 'string' ||
        partTypes.get(partKey(properties.sessionID, properties.partID)) !== 'text'
      ) {
        return;
      }
      const payload = {
        version: 1,
        sessionID: coordinatorAlias,
        messageID: properties.messageID,
        partID: properties.partID,
        delta: properties.delta,
      };
      process.stdout.write(`${DELTA_PREFIX}${JSON.stringify(payload)}\n`);
    },
  };
};
