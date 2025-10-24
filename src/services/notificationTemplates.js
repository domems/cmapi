// src/services/notificationTemplates.js
export function buildPushFromTemplate(template, payload = {}) {
    switch (template) {
        case "miner_offline":
            return { title: "Miner offline", body: payload.worker ? `${payload.worker} is offline` : "A miner went offline", data: { type: "miner_status", ...payload } };
        case "miner_recovered":
            return { title: "Miner online", body: payload.worker ? `${payload.worker} is back online` : "A miner is back online", data: { type: "miner_status", ...payload } };
        case "miner_maintenance": // ⬅️ novo
            return { title: "Maintenance mode", body: payload.worker ? `${payload.worker} entered maintenance` : "A miner entered maintenance", data: { type: "miner_status", ...payload } };
        case "invoice_closed":
            return { title: "Invoice closed", body: "Your monthly invoice has closed.", data: { type: "invoice_closed", ...payload } };
        case "invoice_late_5d":
            return { title: "Invoice overdue", body: "Your invoice is unpaid after 5 days.", data: { type: "invoice_late_5d", ...payload } };
        default:
            return { title: "Notification", body: "", data: payload };
    }
}
