const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new sqlite3.Database("./pharmacie.db");

function now() {
  return new Date().toISOString();
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function ok(res, message, data = []) {
  res.json({
    success: true,
    message,
    data
  });
}

function fail(res, message, error = null, status = 500) {
  res.status(status).json({
    success: false,
    message,
    error: error ? error.message : null,
    data: []
  });
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS villes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nom TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      lastUpdated TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS quartiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ville_slug TEXT NOT NULL,
      nom TEXT NOT NULL,
      zone TEXT NOT NULL,
      lastUpdated TEXT,
      UNIQUE(ville_slug, zone)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pharmacies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ville_slug TEXT NOT NULL,
      zone TEXT NOT NULL,
      nom TEXT NOT NULL,
      adresse TEXT,
      telephone TEXT,
      active INTEGER DEFAULT 1,
      lastUpdated TEXT,
      UNIQUE(ville_slug, zone, nom, adresse)
    )
  `);
});

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "PharmaGarde API running ✅",
    endpoints: [
      "/api/sync/villes",
      "/api/sync/quartiers/:ville",
      "/api/sync/pharmacies/:ville/:zone",
      "/api/villes",
      "/api/quartiers/:ville",
      "/api/pharmacies/:ville/:zone"
    ]
  });
});

/* =========================
   SYNC VILLES FROM TELECONTACT
========================= */
app.get("/api/sync/villes", async (req, res) => {
  try {
    const url = "https://www.telecontact.ma/services/pharmacies-de-garde/Maroc";

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const $ = cheerio.load(response.data);
    const villes = [];

    $("a").each((i, el) => {
      const text = $(el).text().replace(/Voir/g, "").trim();
      const href = $(el).attr("href");

      if (href && href.includes("/services/pharmacies-de-garde/")) {
        const slug = href
          .split("/services/pharmacies-de-garde/")[1]
          .replace("-Maroc", "")
          .replace("/", "")
          .toLowerCase()
          .trim();

        if (text && slug && slug !== "maroc") {
          if (!villes.some(v => v.slug === slug)) {
            villes.push({
              nom: text,
              slug
            });
          }
        }
      }
    });

    for (const v of villes) {
      await run(
        `
        INSERT INTO villes (nom, slug, lastUpdated)
        VALUES (?, ?, ?)
        ON CONFLICT(slug)
        DO UPDATE SET
          nom = excluded.nom,
          lastUpdated = excluded.lastUpdated
        `,
        [v.nom, v.slug, now()]
      );
    }

    ok(res, `${villes.length} villes synced ✅`, villes);
  } catch (error) {
    fail(res, "Erreur sync villes", error);
  }
});

/* =========================
   SYNC QUARTIERS FROM TELECONTACT
========================= */
app.get("/api/sync/quartiers/:ville", async (req, res) => {
  try {
    const ville = req.params.ville.toLowerCase().trim();

    const pageUrl = `https://www.telecontact.ma/services/pharmacies-de-garde/${ville}-Maroc`;

    const response = await axios.get(pageUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const $ = cheerio.load(response.data);
    const quartiers = [];

    $("a").each((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href");

      if (href && href.includes(`/pharmacie-de-garde-zone/${ville}/`)) {
        const zone = href
          .split(`/pharmacie-de-garde-zone/${ville}/`)[1]
          .replace(".html", "")
          .trim();

        if (zone && !quartiers.some(q => q.zone === zone)) {
          quartiers.push({
            nom: text || zone,
            zone
          });
        }
      }
    });

    for (const q of quartiers) {
      await run(
        `
        INSERT INTO quartiers (ville_slug, nom, zone, lastUpdated)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(ville_slug, zone)
        DO UPDATE SET
          nom = excluded.nom,
          lastUpdated = excluded.lastUpdated
        `,
        [ville, q.nom, q.zone, now()]
      );
    }

    ok(res, `${quartiers.length} quartiers synced ✅`, quartiers);
  } catch (error) {
    fail(res, "Erreur sync quartiers", error);
  }
});

/* =========================
   SYNC PHARMACIES FROM TELECONTACT
========================= */
app.get("/api/sync/pharmacies/:ville/:zone", async (req, res) => {
  try {
    const ville = req.params.ville.toLowerCase().trim();
    const zone = req.params.zone.toLowerCase().trim();

    const apiUrl = `https://www.telecontact.ma/trouver/pharmacie-guarde-zone-jour-fonctionalite.php?ville=${ville}&zone=${zone}&jour=1&act=pharmacie-ville-zone`;

    const response = await axios.get(apiUrl, {
      timeout: 15000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": `https://www.telecontact.ma/pharmacie-de-garde-zone/${ville}/${zone}.html`
      }
    });

    const rows = response.data && response.data.data ? response.data.data : [];
    const pharmacies = [];

    for (const p of rows) {
      const pharmacie = {
        nom: p.rs_comp || "N/A",
        adresse: p.adresse || "N/A",
        telephone: p.tel || "N/A",
        ville,
        zone
      };

      pharmacies.push(pharmacie);

      await run(
        `
        INSERT INTO pharmacies
        (ville_slug, zone, nom, adresse, telephone, active, lastUpdated)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(ville_slug, zone, nom, adresse)
        DO UPDATE SET
          telephone = excluded.telephone,
          active = 1,
          lastUpdated = excluded.lastUpdated
        `,
        [
          ville,
          zone,
          pharmacie.nom,
          pharmacie.adresse,
          pharmacie.telephone,
          now()
        ]
      );
    }

    ok(res, `${pharmacies.length} pharmacies synced ✅`, pharmacies);
  } catch (error) {
    fail(res, "Erreur sync pharmacies", error);
  }
});

/* =========================
   READ FROM SQLITE
========================= */
app.get("/api/villes", async (req, res) => {
  try {
    const rows = await all(
      "SELECT nom, slug FROM villes ORDER BY nom ASC"
    );

    ok(res, "Villes loaded ✅", rows);
  } catch (error) {
    fail(res, "Erreur loading villes", error);
  }
});

app.get("/api/quartiers/:ville", async (req, res) => {
  try {
    const ville = req.params.ville.toLowerCase().trim();

    const rows = await all(
      `
      SELECT nom, zone
      FROM quartiers
      WHERE ville_slug = ?
      ORDER BY nom ASC
      `,
      [ville]
    );

    ok(res, "Quartiers loaded ✅", rows);
  } catch (error) {
    fail(res, "Erreur loading quartiers", error);
  }
});

app.get("/api/pharmacies/:ville/:zone", async (req, res) => {
  try {
    const ville = req.params.ville.toLowerCase().trim();
    const zone = req.params.zone.toLowerCase().trim();

    const rows = await all(
      `
      SELECT
        nom,
        adresse,
        telephone,
        ville_slug AS ville,
        zone
      FROM pharmacies
      WHERE ville_slug = ?
        AND zone = ?
        AND active = 1
      ORDER BY nom ASC
      `,
      [ville, zone]
    );

    ok(res, "Pharmacies loaded ✅", rows);
  } catch (error) {
    fail(res, "Erreur loading pharmacies", error);
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    data: []
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} 🚀`);
});