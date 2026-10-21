/**
 * Criterya — envío de correo por SMTP propio (Zoho)
 * -------------------------------------------------
 * Reemplaza el envío que hacía el Apps Script desde una cuenta de Gmail.
 * El correo sale desde contacto@criterya.com.ar, autenticado contra el SMTP
 * de Zoho. Ni Gmail ni ninguna cuenta de terceros participan.
 *
 * Las credenciales NUNCA van en el código: se leen de las variables de
 * entorno del proyecto en Vercel.
 *
 *   SMTP_HOST   servidor de Zoho (p. ej. smtp.zoho.com — tomarlo de Zoho)
 *   SMTP_PORT   465 con SSL, o 587 con STARTTLS
 *   SMTP_USER   contacto@criterya.com.ar
 *   SMTP_PASS   contraseña de aplicación generada en Zoho
 *   MAIL_INTERNO  destino de los avisos internos (por defecto, SMTP_USER)
 *
 * Esta función atiende tres tipos de envío. Hoy solo la usa el formulario de
 * contacto; express e integral quedan listos para engancharse después.
 */

const nodemailer = require("nodemailer");

const MAX_BODY = 200 * 1024;          // el anexo del integral es grande, pero no tanto
const TIPOS = ["contacto", "express", "integral"];

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* Una sola línea de datos del formulario, como fila de tabla. */
function fila(etiqueta, valor) {
  if (!valor) return "";
  return "<tr><td style='padding:7px 14px 7px 0;border-bottom:1px solid #e4eaee;" +
    "color:#5F7486;font-size:13px;white-space:nowrap;vertical-align:top'>" + esc(etiqueta) +
    "</td><td style='padding:7px 0;border-bottom:1px solid #e4eaee;font-size:14px'>" +
    esc(valor) + "</td></tr>";
}

function envoltorio(titulo, contenido, pie) {
  return "<div style=\"font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;" +
    "color:#12212E;max-width:620px;margin:0 auto;padding:4px\">" +
    "<h2 style='color:#043760;font-size:19px;margin:0 0 4px'>" + esc(titulo) + "</h2>" +
    "<div style='height:4px;width:120px;border-radius:2px;margin-bottom:20px;" +
    "background:linear-gradient(90deg,#9A3B2C 0 25%,#B5822C 25% 50%,#2F8FA0 50% 75%,#043760 75% 100%)'></div>" +
    contenido +
    "<p style='margin-top:24px;font-size:12px;color:#8296a5;line-height:1.6'>" + pie + "</p></div>";
}

function cuerpoContacto(d) {
  const tabla = "<table style='border-collapse:collapse;width:100%'>" +
    fila("Nombre", d.nombre) + fila("Empresa", d.empresa) +
    fila("Correo", d.email) + fila("Teléfono", d.telefono) +
    fila("Rubro", d.rubro) + "</table>";
  const mensaje = d.mensaje
    ? "<h3 style='color:#043760;font-size:14px;margin:22px 0 8px'>Mensaje</h3>" +
      "<div style='font-size:14px;line-height:1.65;white-space:pre-wrap;" +
      "border-left:3px solid #D8E2E8;padding-left:14px'>" + esc(d.mensaje) + "</div>"
    : "";
  return envoltorio("Consulta desde el sitio", tabla + mensaje,
    "Enviado desde el formulario de criterya.com.ar." +
    (d.origen ? " Origen: " + esc(d.origen) + "." : ""));
}

function cuerpoDiagnostico(d, tipo) {
  const areas = Array.isArray(d.areas) ? d.areas : [];
  const filasAreas = areas.map(function (a) {
    return "<tr><td style='padding:6px 10px 6px 0;border-bottom:1px solid #e4eaee;font-size:14px'>" +
      esc(a.nombre) + "</td><td style='padding:6px 10px;border-bottom:1px solid #e4eaee;" +
      "text-align:center;font-size:14px;font-weight:600'>" + esc(a.pts) +
      "</td><td style='padding:6px 0;border-bottom:1px solid #e4eaee;text-align:right;" +
      "font-size:13px;color:#5F7486'>" + esc(a.banda) + "</td></tr>";
  }).join("");

  const datos = "<table style='border-collapse:collapse;width:100%'>" +
    fila("Empresa", d.empresa) + fila("Persona", d.persona || d.nombre) +
    fila("Correo", d.email) + fila("Teléfono", d.telefono) +
    fila("Puntaje global", (d.global != null ? d.global + " / 100" : "")) +
    fila("Nivel", d.banda) + "</table>";

  const bloqueAreas = filasAreas
    ? "<h3 style='color:#043760;font-size:14px;margin:22px 0 8px'>Áreas de gestión</h3>" +
      "<table style='border-collapse:collapse;width:100%'>" + filasAreas + "</table>"
    : "";

  return envoltorio(
    tipo === "integral" ? "Diagnóstico integral completado" : "Diagnóstico express completado",
    datos + bloqueAreas,
    "Aviso interno. El detalle completo y el anexo técnico quedan registrados en la planilla."
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Método no permitido" });
  }

  const faltan = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"].filter(function (k) { return !process.env[k]; });
  if (faltan.length) {
    console.error("Faltan variables de entorno:", faltan.join(", "));
    return res.status(500).json({ ok: false, error: "El envío no está configurado" });
  }

  let d = req.body;
  if (typeof d === "string") {
    if (d.length > MAX_BODY) return res.status(413).json({ ok: false, error: "Contenido demasiado grande" });
    try { d = JSON.parse(d); } catch (e) { return res.status(400).json({ ok: false, error: "JSON inválido" }); }
  }
  if (!d || typeof d !== "object") return res.status(400).json({ ok: false, error: "Sin datos" });

  const tipo = TIPOS.indexOf(d.tipo) >= 0 ? d.tipo : "contacto";

  /* Validación mínima: sin esto, el buzón se llena de envíos vacíos. */
  if (tipo === "contacto") {
    if (!String(d.nombre || "").trim() || !String(d.mensaje || "").trim()) {
      return res.status(400).json({ ok: false, error: "Faltan el nombre o el mensaje" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(d.email || "").trim())) {
      return res.status(400).json({ ok: false, error: "Correo inválido" });
    }
  }

  const interno = process.env.MAIL_INTERNO || process.env.SMTP_USER;
  const puerto = Number(process.env.SMTP_PORT || 465);

  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: puerto,
    secure: puerto === 465,            // 465 va con SSL directo; 587 negocia STARTTLS
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });

  const empresa = String(d.empresa || "").trim();
  let asunto, html;

  if (tipo === "contacto") {
    asunto = "[Consulta web] " + (String(d.nombre || "").trim() || "Sin nombre") +
             (empresa ? " · " + empresa : "");
    html = cuerpoContacto(d);
  } else {
    asunto = (tipo === "integral" ? "[Integral] " : "[Express] ") +
             (empresa || "Sin empresa") +
             (d.global != null ? " · " + d.global + "/100" : "");
    html = cuerpoDiagnostico(d, tipo);
  }

  try {
    await transporte.sendMail({
      from: { name: "Criterya", address: process.env.SMTP_USER },
      to: interno,
      replyTo: d.email ? String(d.email).trim() : undefined,
      subject: asunto,
      html: html,
      text: "Este correo requiere un lector con formato HTML."
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    /* El detalle va al log de Vercel, nunca al navegador del visitante. */
    console.error("Fallo el envío SMTP:", err && err.message);
    return res.status(502).json({ ok: false, error: "No se pudo enviar el correo" });
  }
};
