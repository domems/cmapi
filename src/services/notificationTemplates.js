// src/services/notificationTemplates.js
export function buildPushFromTemplate(template, payload = {}) {
    switch (template) {
        case "miner_offline":
            return { title: "Miner offline", body: payload.worker ? `${payload.worker} is offline` : "A miner went offline", data: { type: "miner_status", ...payload } };
        case "miner_recovered":
            return { title: "Miner online", body: payload.worker ? `${payload.worker} is back online` : "A miner is back online", data: { type: "miner_status", ...payload } };
        case "miner_maintenance": // ⬅️ novo
            return { title: "Maintenance mode", body: payload.worker ? `${payload.worker} entered maintenance` : "A miner entered maintenance", data: { type: "miner_status", ...payload } };
        case "staff_miner_offline_p1":
            return {
                title: "P1: Miner offline",
                body: payload.worker ? `${payload.worker} went offline` : `Miner #${payload.minerId} went offline`,
                data: { type: "staff_alert", severity: "P1", ...payload }
            };
        case "staff_miner_recovered_p2":
            return {
                title: "P2: Miner recovered",
                body: payload.worker ? `${payload.worker} is back online` : `Miner #${payload.minerId} is back online`,
                data: { type: "staff_alert", severity: "P2", ...payload }
            };
        case "staff_miner_maintenance_p2":
            return {
                title: "P2: Maintenance state",
                body: payload.worker ? `${payload.worker} entered maintenance` : `Miner #${payload.minerId} entered maintenance`,
                data: { type: "staff_alert", severity: "P2", ...payload }
            };
        case "invoice_closed":
            return { title: "Invoice closed", body: "Your monthly invoice has closed.", data: { type: "invoice_closed", ...payload } };
        case "invoice_late_5d":
            return { title: "Invoice overdue", body: "Your invoice is unpaid after 5 days.", data: { type: "invoice_late_5d", ...payload } };
        default:
            return { title: "Notification", body: "", data: payload };
    }
}
