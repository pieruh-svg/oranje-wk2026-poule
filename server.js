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

// LIVE API SYNC ENGINE
async function fetchLiveUitslagen() {
    try {
        const response = await fetch('https://api.worldcup-results.com/v1/teams/netherlands');
        if (!response.ok) return false;
        const data = await response.json();

        // KPN Groep F Mapping
        const apiMatches = [
            { id: 1, opponent: 'Japan' },
            { id: 2, opponent: 'Zweden' },
            { id: 3, opponent: 'Tunisia' }
        ];

        let databaseAangepast = false;

        for (let map of apiMatches) {
            const liveMatch = data.matches.find(m => m.home_team.includes(map.opponent) || m.away_team.includes(map.opponent));
            
            if (liveMatch && liveMatch.status === 'FINISHED') {
                const thuisUitslag = liveMatch.home_team_score;
                const uitUitslag = liveMatch.away_team_score;

                const result = await pool.query(
                    `UPDATE wedstrijden 
                     SET uitslag_thuis = $1, uitslag_uit = $2, status = 'GESPEELD' 
                     WHERE id = $3 AND status = 'GEPLAND'`, 
                    [thuisUitslag, uitUitslag, map.id]
                );
                
                if (result.rowCount > 0) {
                    databaseAangepast = true;
                }
            }
        }
        
        if (databaseAangepast) {
            await updateRanglijst();
        }
        return true;
    } catch (err) {
        console.error("Fout bij ophalen live uitslagen:", err.message);
        return false;
    }
}

// API ROUTE VOOR UPTIMEROBOT
app.get('/api/cron/sync', async (req, res) => {
    const syncSuccesvol = await fetchLiveUitslagen();
    
    // We sturen ALTIJD een nette status 200 terug, zodat UptimeRobot groen blijft
    if (syncSuccesvol) {
        res.status(200).json({ success: true, message: "Sync succesvol uitgevoerd." });
    } else {
        res.status(200).json({ success: false, message: "Sync uitgevoerd, maar API-bron was onbereikbaar." });
    }
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

// API: Admin uitslag handmatig (Backup)
app.post('/api/admin/uitslag', async (req, res) => {
    const { password, wedstrijd_id, uitslag_thuis, uitslag_uit, status, eindgoud } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: "Onjuist!" });

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
