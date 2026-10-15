import type { ConnectorCatalogProbe } from "@regenic/connector-contract";

export async function probeWeComCatalog(input: {
  env: NodeJS.ProcessEnv;
}): Promise<ConnectorCatalogProbe> {
  const botId = input.env.WECOM_BOT_ID?.trim();
  const secret = input.env.WECOM_BOT_SECRET?.trim();
  if (!botId || !secret) {
    return {
      services: {
        "wecom-bot": {
          ready: false,
          hint: "probe.missing",
        },
      },
    };
  }
  return {
    services: {
      "wecom-bot": {
        ready: true,
        hint: "probe.ready",
      },
    },
  };
}
