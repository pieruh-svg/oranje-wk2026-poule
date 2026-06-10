const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PASSWORD = "admin1234";

// PUNTEN LOGICA ENGINE
function berekenMatchPunten(vThuis, vUit, uThuis, uUit) {
    if (uThuis === null || uUit === null) return 0;
    if (vThuis === uThuis && vUit === uUit) return 3; // Exact goed
    
    const vWinnaar = vThuis > vUit ? 'THUIS' : (vThuis < vUit ? 'UIT' : 'GELIJK');
    const uWinnaar = uThuis > uUit ? 'THUIS' : (uThuis < uUit ? 'UIT' : 'GELIJK');
    
    if (vWinnaar === uWinnaar) return 2; // Trend goed
    return 0;
}

async function updateRanglijst(optioneleWereldkampioen = null) {
    const deelnemers = await pool.query('SELECT * FROM deelnemers');
    const wedstrijden = await pool.query('SELECT * FROM wedstrijden WHERE status = \'GESPEELD\'');
    
    for (let user of deelnemers.rows) {
        let totalePunten = 0;
        const voorspellingen = await pool.query('SELECT * FROM voorspellingen WHERE deelnemer_id = $1', [user.id]);
        
        for (let v of voorspellingen.rows) {
            const match = wedstrijden.rows.find(m => m.id === v.wedstrijd_id);
            if (match) {
                totalePunten += berekenMatchPunten(v.voorspelling_thuis, v.voorspelling_uit, match.uitslag_thuis, match.uitslag_uit);
            }
        }
        
        if (optioneleWereldkampioen && user.wereldkampioen.toLowerCase().trim() === optioneleWereldkampioen.toLowerCase().trim()) {
            totalePunten += 5;
        }
        
        await pool.query('UPDATE deelnemers SET punten = $1 WHERE id = $2', [totalePunten, user.id]);
    }
}

// API: Haal status op
app.get('/api/data', async (req, res) => {
    try {
        const deelnemers = await pool.query('SELECT * FROM deelnemers ORDER BY punten DESC, naam ASC');
        const wedstrijden = await pool.query('SELECT * FROM wedstrijden ORDER BY id ASC');
        const voorspellingen = await pool.query('SELECT * FROM voorspellingen');
        res.json({ deelnemers: deelnemers.rows, wedstrijden: wedstrijden.rows, voorspellingen: voorspellingen.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Deelnemer toevoegen
app.post('/api/deelnemers', async (req, res) => {
    const { naam, wereldkampioen } = req.body;
    try {
        const nieuw = await pool.query('INSERT INTO deelnemers (naam, wereldkampioen) VALUES ($1, $2) RETURNING *', [naam, wereldkampioen]);
        res.json(nieuw.rows[0]);
    } catch (err) {
        res.status(400).json({ error: "Naam bestaat al of ongeldige invoer." });
    }
});

// API: Voorspelling opslaan
app.post('/api/voorspellingen', async (req, res) => {
    const { deelnemer_id, wedstrijd_id, voorspelling_thuis, voorspelling_uit } = req.body;
    try {
        await pool.query(
            `INSERT INTO voorspellingen (deelnemer_id, wedstrijd_id, voorspelling_thuis, voorspelling_uit) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (deelnemer_id, wedstrijd_id) 
             DO UPDATE SET voorspelling_thuis = $3, voorspelling_uit = $4`,
            [deelnemer_id, wedstrijd_id, voorspelling_thuis, voorspelling_uit]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Admin uitslag invoeren/wijzigen (beveiligd)
app.post('/api/admin/uitslag', async (req, res) => {
    const { password, wedstrijd_id, uitslag_thuis, uitslag_uit, status, eindgoud } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Onjuist wachtwoord!" });

    try {
        if (status === 'GEPLAND') {
            await pool.query('UPDATE wedstrijden SET uitslag_thuis = NULL, uitslag_uit = NULL, status = \'GEPLAND\' WHERE id = $1', [wedstrijd_id]);
        } else {
            await pool.query('UPDATE wedstrijden SET uitslag_thuis = $1, uitslag_uit = $2, status = \'GESPEELD\' WHERE id = $3', [uitslag_thuis, uitslag_uit, wedstrijd_id]);
        }
        await updateRanglijst(eindgoud);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Admin speler verwijderen (beveiligd)
app.post('/api/admin/verwijder-speler', async (req, res) => {
    const { password, herstel_id } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Onjuist wachtwoord!" });

    try {
        await pool.query('DELETE FROM deelnemers WHERE id = $1', [herstel_id]);
        await updateRanglijst();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(`Poule server draait op poort ${port}`));