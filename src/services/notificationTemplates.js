// src/services/notificationTemplates.js
export function buildPushFromTemplate(template, payload = {}) {
  switch (template) {
    case "miner_offline":
      return {
        title: "Miner offline",
        body: `${payload.worker ?? "Miner"} went OFFLINE.`,
        data: {
          type: "miner_status",
          workerName: payload.worker,
          prev: payload.from,
          next: payload.to,
        },
      };

    case "miner_recovered":
      return {
        title: "Miner online again",
        body: `${payload.worker ?? "Miner"} is ONLINE.`,
        data: {
          type: "miner_status",
          workerName: payload.worker,
          prev: payload.from,
          next: payload.to,
        },
      };

    case "invoice_closed":
      return {
        title: "Invoice closed",
        body: `Invoice ${payload.invoiceId ?? ""} has been closed.`,
        data: { type: "invoice_closed", invoiceId: payload.invoiceId },
      };

    case "invoice_late_5d":
      return {
        title: "Invoice pending",
        body: `Invoice ${payload.invoiceId ?? ""} is unpaid after 5 days.`,
        data: { type: "invoice_late_5d", invoiceId: payload.invoiceId },
      };

    default:
      return {
        title: "Notification",
        body: "You have a new notification.",
        data: { type: "generic", template, ...payload },
      };
  }
}
