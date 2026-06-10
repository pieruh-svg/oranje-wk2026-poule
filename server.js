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

const ADMIN_PASSWORD = "admin@admin";
const API_KEY = process.env.FOOTBALL_API_KEY;

// PUNTEN LOGICA ENGINE (NIEUW SYSTEEM)
function berekenMatchPunten(vThuis, vUit, uThuis, uUit) {
    if (uThuis === null || uUit === null) return 0;
    
    let punten = 0;

    // 1. Check uitslag qua doelpunten (2 punten per team dat exact goed is)
    if (vThuis === uThuis) punten += 2;
    if (vUit === uUit) punten += 2;

    // Als de doelpunten al punten hebben opgeleverd, skippen we de trend-controle
    if (punten > 0) return punten;

    // 2. Winnend land goed? (1 punt)
    const vWinnaar = vThuis > vUit ? 'THUIS' : (vThuis < vUit ? 'UIT' : 'GELIJK');
    const uWinnaar = uThuis > uUit ? 'THUIS' : (uThuis < uUit ? 'UIT' : 'GELIJK');
    
    if (vWinnaar === uWinnaar) {
        return 1;
    }
    
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

// LIVE API SYNC ENGINE
async function fetchLiveUitslagen() {
    if (!API_KEY) return false;
    try {
        const response = await fetch('https://api.football-data.org/v4/competitions/WC/matches', {
            headers: { 'X-Auth-Token': API_KEY }
        });
        if (!response.ok) return false;
        const data = await response.json();

        const mijnMatchen = [
            { id: 1, tegenstander: 'Japan' },
            { id: 2, tegenstander: 'Sweden' },
            { id: 3, tegenstander: 'Tunisia' }
        ];

        let databaseAangepast = false;

        for (let match of data.matches) {
            const isNederlandThuis = match.homeTeam.name === 'Netherlands';
            const isNederlandUit = match.awayTeam.name === 'Netherlands';

            if (isNederlandThuis || isNederlandUit) {
                const tegenstanderNaam = isNederlandThuis ? match.awayTeam.name : match.homeTeam.name;
                const matchKoppeling = mijnMatchen.find(m => tegenstanderNaam.includes(m.tegenstander));

                if (matchKoppeling && match.status === 'FINISHED') {
                    const thuisScore = match.score.fullTime.home;
                    const uitScore = match.score.fullTime.away;

                    const result = await pool.query(
                        `UPDATE wedstrijden 
                         SET uitslag_thuis = $1, uitslag_uit = $2, status = 'GESPEELD' 
                         WHERE id = $3 AND status = 'GEPLAND'`, 
                        [thuisScore, uitScore, matchKoppeling.id]
                    );
                    if (result.rowCount > 0) databaseAangepast = true;
                }
            }
        }
        if (databaseAangepast) await updateRanglijst();
        return true;
    } catch (err) {
        return false;
    }
}

app.get('/api/cron/sync', async (req, res) => {
    const syncSuccesvol = await fetchLiveUitslagen();
    res.status(200).json({ success: syncSuccesvol });
});

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
        res.status(400).json({ error: "Naam bestaat al." });
    }
});

// API: Voorspelling opslaan
app.post('/api/voorspellingen', async (req, res) => {
    const { deelnemer_id, wedstrijd_id, voorspelling_thuis, voorspelling_uit } = req.body;
    try {
        const matchCheck = await pool.query('SELECT status FROM wedstrijden WHERE id = $1', [wedstrijd_id]);
        if (matchCheck.rows.length > 0 && matchCheck.rows[0].status === 'GESPEELD') {
            return res.status(400).json({ error: "Deze wedstrijd is al afgelopen!" });
        }

        const bestaandeCheck = await pool.query(
            'SELECT deelnemer_id FROM voorspellingen WHERE deelnemer_id = $1 AND wedstrijd_id = $2',
            [deelnemer_id, wedstrijd_id]
        );

        if (bestaandeCheck.rows.length > 0) {
            return res.status(400).json({ error: "Je hebt deze voorspelling al definitief opgeslagen!" });
        }

        await pool.query(
            `INSERT INTO voorspellingen (deelnemer_id, wedstrijd_id, voorspelling_thuis, voorspelling_uit) 
             VALUES ($1, $2, $3, $4)`,
            [deelnemer_id, wedstrijd_id, voorspelling_thuis, voorspelling_uit]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Admin uitslag handmatig
app.post('/api/admin/uitslag', async (req, res) => {
    const { password, wedstrijd_id, uitslag_thuis, uitslag_uit, status, eindgoud } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Onjuist!" });

    try {
        const huidigeStatus = await pool.query('SELECT status FROM wedstrijden WHERE id = $1', [wedstrijd_id]);
        if (huidigeStatus.rows.length > 0 && huidigeStatus.rows[0].status === 'GESPEELD') {
            return res.status(400).json({ error: "Deze uitslag staat al definitief vast!" });
        }

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

// API: Admin uitslag wissen / resetten naar gepland
app.post('/api/admin/wis-uitslag', async (req, res) => {
    const { password, wedstrijd_id } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Onjuist admin wachtwoord!" });

    try {
        await pool.query(
            `UPDATE wedstrijden 
             SET uitslag_thuis = NULL, uitslag_uit = NULL, status = 'GEPLAND' 
             WHERE id = $1`, 
            [wedstrijd_id]
        );
        await updateRanglijst();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Admin speler verwijderen
app.post('/api/admin/verwijder-speler', async (req, res) => {
    const { password, herstel_id } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Onjuist!" });
    try {
        await pool.query('DELETE FROM deelnemers WHERE id = $1', [herstel_id]);
        await updateRanglijst();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(`Poule server draait op poort ${port}`));
