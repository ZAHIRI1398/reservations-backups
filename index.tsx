/**
 * Backup PostgreSQL des réservations
 * - Envoie le fichier SQL par email (via Resend)
 * - Pousse le fichier sur GitHub (via l'API GitHub)
 *
 * Variables d'environnement requises :
 * - DATABASE_URL          : URL PostgreSQL (fournie par Railway)
 * - RESEND_API_KEY        : clé API Resend
 * - BACKUP_EMAIL_TO       : adresse email destinataire
 * - EMAIL_FROM            : adresse expéditeur (contact@leboucheaoreilles.be)
 * - GITHUB_TOKEN          : token GitHub (Personal Access Token)
 * - GITHUB_REPO_OWNER     : propriétaire du repo (ex: ZAHIRI1398)
 * - GITHUB_REPO_NAME      : nom du repo (ex: reservations-backups)
 */

import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const BACKUP_EMAIL_TO = process.env.BACKUP_EMAIL_TO || "ZAHIRI.Abdelaziz@ste-bernadette.be";
const EMAIL_FROM = process.env.EMAIL_FROM || "contact@leboucheaoreilles.be";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER || "";
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME || "";

async function getReservations(): Promise<{ count: number; sql: string }> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    const result = await client.query("SELECT * FROM reservations ORDER BY id");
    const rows = result.rows;
    const count = rows.length;

    const now = new Date().toISOString();
    let sql = `-- Backup des réservations - ${now}\n`;
    sql += `-- Total: ${count} réservations\n\n`;
    sql += `DELETE FROM reservations;\n\n`;

    const columns = [
      "id", "reference", "groupe_reference", "nom", "email", "telephone",
      "date", "heure", "personnes", "message", "statut", "created_at",
    ];

    for (const row of rows) {
      const values = columns.map((col) => {
        const val = row[col];
        if (val === null || val === undefined) return "NULL";
        if (typeof val === "number") return String(val);
        // Échapper les apostrophes
        const escaped = String(val).replace(/'/g, "''");
        return `'${escaped}'`;
      });
      sql += `INSERT INTO reservations (${columns.join(", ")}) VALUES (${values.join(", ")});\n`;
    }

    return { count, sql };
  } finally {
    client.release();
    await pool.end();
  }
}

async function sendEmailBackup(sql: string, count: number, dateStr: string): Promise<void> {
  if (!RESEND_API_KEY) {
    console.log("⚠️  RESEND_API_KEY non configurée - email non envoyé");
    return;
  }

  console.log("📧 Envoi du backup par email...");

  // Limiter la taille de l'email (Resend a une limite ~1MB pour le HTML)
  const sqlPreview = sql.length > 50000
    ? sql.substring(0, 50000) + "\n\n... (tronqué, voir le fichier GitHub pour le backup complet)\n"
    : sql;

  const html = `
    <html>
    <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background-color: #f8f9fa; padding: 20px; border-radius: 10px; border-left: 4px solid #28a745;">
        <h2 style="color: #28a745; margin-top: 0;">💾 Backup des réservations</h2>
        <p><strong>Date :</strong> ${dateStr}</p>
        <p><strong>Nombre de réservations :</strong> ${count}</p>
        <p><strong>Taille :</strong> ${(sql.length / 1024).toFixed(2)} KB</p>
      </div>
      <div style="background-color: #ffffff; padding: 20px; border: 1px solid #dee2e6; border-radius: 10px; margin: 20px 0;">
        <h3 style="color: #495057;">Contenu du backup (SQL)</h3>
        <pre style="background: #f1f1f1; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 12px; max-height: 400px; overflow-y: auto;">${sqlPreview.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
      </div>
      <div style="background-color: #e9ecef; padding: 15px; border-radius: 10px; text-align: center;">
        <p style="margin: 0; color: #6c757d;">Pour restaurer : copiez le SQL ci-dessus et exécutez-le dans votre base PostgreSQL.</p>
      </div>
    </body>
    </html>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [BACKUP_EMAIL_TO],
      subject: `💾 Backup réservations - ${dateStr} (${count} réservations)`,
      html: html,
    }),
  });

  if (response.ok) {
    const data = await response.json();
    console.log(`✅ Email envoyé avec succès! ID: ${data.id}`);
  } else {
    const errorText = await response.text();
    console.log(`❌ Erreur envoi email: ${response.status} - ${errorText}`);
  }
}

async function pushToGitHub(sql: string, dateStr: string): Promise<void> {
  if (!GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME) {
    console.log("⚠️  Variables GitHub non configurées - backup non poussé sur GitHub");
    return;
  }

  console.log("📂 Envoi du backup sur GitHub...");

  const fileName = `reservations_backup_${dateStr.split("T")[0]}.sql`;
  const path = `backups/${fileName}`;
  const content = Buffer.from(sql).toString("base64");

  // Vérifier si le fichier existe déjà (pour obtenir le SHA)
  let sha: string | undefined;
  try {
    const checkResponse = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${path}`,
      {
        headers: {
          "Authorization": `Bearer ${GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3+json",
        },
      }
    );
    if (checkResponse.ok) {
      const fileData = await checkResponse.json();
      sha = fileData.sha;
    }
  } catch {
    // Le fichier n'existe pas encore, c'est normal
  }

  // Créer ou mettre à jour le fichier
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: `Backup ${dateStr} - ${fileName}`,
        content: content,
        ...(sha ? { sha } : {}),
      }),
    }
  );

  if (response.ok) {
    const data = await response.json();
    console.log(`✅ Backup poussé sur GitHub: ${data.content.html_url}`);
  } else {
    const errorText = await response.text();
    console.log(`❌ Erreur GitHub: ${response.status} - ${errorText}`);
  }
}

async function main() {
  console.log("🔄 Démarrage du backup PostgreSQL...");

  try {
    const { count, sql } = await getReservations();
    const dateStr = new Date().toISOString();
    const fileName = `reservations_backup_${dateStr.split("T")[0]}.sql`;

    console.log(`✅ ${count} réservations trouvées`);
    console.log(`📄 Fichier: ${fileName}`);
    console.log(`💾 Taille: ${(sql.length / 1024).toFixed(2)} KB`);

    // Envoyer par email
    await sendEmailBackup(sql, count, dateStr);

    // Pousser sur GitHub
    await pushToGitHub(sql, dateStr);

    console.log("🎉 Backup complété avec succès!");
  } catch (error) {
    console.error("❌ Erreur lors du backup:", error);
    process.exit(1);
  }
}

main();
