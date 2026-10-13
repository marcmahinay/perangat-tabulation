'use strict';

const crypto = require('node:crypto');

// Source: "Perangat Festival 2026 - Official Judging Criteria & Deductions".
const CATEGORIES = [
  {
    name: 'Dance Showdown',
    apply_deductions: 1,
    placement_titles: ['CHAMPION', '1ST RUNNER UP', '2ND RUNNER UP'],
    criteria: [
      ['Performance and Choreography', 35, 'Execution, mastery and coordination, synchronicity & precision, energy, projection; Artistic flow, transitions, and structural coherence of the performance; Precision, cleanliness and control of movements.'],
      ['Creativity and Originality', 25, 'Integration of local culture, values, and identity that honor the festival\'s essence; Authentic representation of "Pag-Asenso" as growth, unity, or progress.'],
      ['Costume / Props', 20, 'Creativity, appropriateness, and overall visual appeal of costumes and props; Harmony of visual elements with the dance theme and choreography; Attention to detail and stage aesthetics.'],
      ['Music', 20, 'Use of traditional instruments, native tunes, and authentic musical elements that reflect the theme and local identity; Uniqueness of arrangement, innovative blending of sounds, and overall creativity in musical interpretation; Balance of instruments, clarity of beats, and overall sound quality during the performance.'],
    ],
  },
  {
    name: 'Best Music',
    apply_deductions: 0,
    placement_titles: ['BEST MUSIC'],
    criteria: [
      ['Authenticity and Fidelity to Subanen Music', 50, 'Faithfulness to traditional Subanen melodies, rhythms, instrumentation, vocal expressions, and other verifiable musical characteristics.'],
      ['Cultural Integrity and Appropriateness', 20, 'Respectful representation of Subanen traditions, including proper use of cultural expressions and avoidance of distortion or misrepresentation.'],
      ['Musical Quality and Cohesion', 15, 'Rhythm, timing, clarity, coordination, and consistency of the musical presentation.'],
      ['Integration with the Dance and Cultural Storytelling', 10, 'Effectiveness of the music in supporting the contingent\'s choreography, narrative, and cultural presentation without compromising authenticity.'],
      ['Overall Auditory Impact', 5, 'Effectiveness and coherence of the music in communicating the spirit of the Perangat Festival.'],
    ],
  },
  {
    name: 'Festival Queen',
    apply_deductions: 0,
    placement_titles: ['FESTIVAL QUEEN'],
    criteria: [
      ['Festival Costume and Cultural Representation', 35, 'Creativity, craftsmanship, visual appeal, and relevance of the costume to the contingent\'s theme and the cultural identity of Misamis Occidental.'],
      ['Grace, Poise, and Stage Presence', 25, 'Confidence, composure, bearing, and ability to command attention during the presentation.'],
      ['Overall Presentation and Visual Impact', 20, 'Harmony of the Festival Queen\'s costume, styling, accessories, and presentation with the contingent\'s overall performance.'],
      ['Projection and Audience Appeal', 20, 'Ability to engage the audience through facial expression, movement, energy, and charisma.'],
    ],
  },
];

const DEDUCTION_TYPES = [
  {
    name: 'Safety & Prohibited Acts Violation',
    points: 5, scope: 'final', unit: 'flat', limit_seconds: null,
    notes: 'Unduly endangering performer safety; using infants/toddlers (3 yrs below), live animals, pyrotechnics/smoke bombs/poppers; actual weapons; liquids on stage.',
  },
  {
    name: 'Exceeding Entrance Time',
    points: 1, scope: 'per_judge', unit: 'flat', limit_seconds: 240,
    notes: 'Entrance max 4 mins (includes up to 2 mins synopsis reading). Any excess 1-59 secs counts as 1 point deduction.',
  },
  {
    name: 'Exceeding Exit Time',
    points: 1, scope: 'per_judge', unit: 'flat', limit_seconds: 120,
    notes: 'Exit max 2 mins. Any excess 1-59 secs counts as 1 point deduction.',
  },
  {
    name: 'Exceeding Actual Performance Time',
    points: 1, scope: 'per_judge', unit: 'per_minute', limit_seconds: 300,
    notes: 'Performance limit 5 mins. 1-59 secs excess not penalized. 1-point deduction starting at 6:00 per minute.',
  },
];

const SETTINGS = {
  event_name: 'Perangat Festival 2026',
  event_subtitle: 'Official Tabulation',
  event_venue: '',
  event_date: '',
  tabulator_name: '',
};

const DEFAULT_JUDGE_COUNT = 3;

// Six digits: sign-in allows 10 wrong guesses per device every 5 minutes, so a
// four-digit code could be guessed during an event; a six-digit one cannot.
function randomAccessCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Loads the Perangat 2026 rule book into a brand-new database. Runs once. */
function seedDatabase(db) {
  if (db.get("SELECT value FROM settings WHERE key = 'seeded'")) return;

  db.tx(() => {
    for (const [key, value] of Object.entries({ ...SETTINGS, seeded: '1' })) {
      db.run('INSERT INTO settings (key, value) VALUES (?, ?)', key, value);
    }

    for (let n = 1; n <= DEFAULT_JUDGE_COUNT; n += 1) {
      db.run('INSERT INTO judges (judge_no, name, access_code) VALUES (?, ?, ?)', n, `Judge ${n}`, randomAccessCode());
    }
    const judgeIds = db.all('SELECT id FROM judges').map((row) => row.id);

    CATEGORIES.forEach((category, index) => {
      const { lastInsertRowid: categoryId } = db.run(
        `INSERT INTO categories (name, sort_order, apply_deductions, ranking_method, placement_titles)
         VALUES (?, ?, ?, 'rank_sum', ?)`,
        category.name, index + 1, category.apply_deductions, JSON.stringify(category.placement_titles),
      );
      category.criteria.forEach(([name, weight, description], position) => {
        db.run(
          'INSERT INTO criteria (category_id, name, description, weight, sort_order) VALUES (?, ?, ?, ?, ?)',
          categoryId, name, description, weight, position + 1,
        );
      });
      for (const judgeId of judgeIds) {
        db.run('INSERT INTO category_judges (category_id, judge_id) VALUES (?, ?)', categoryId, judgeId);
      }
    });

    DEDUCTION_TYPES.forEach((type, index) => {
      db.run(
        'INSERT INTO deduction_types (name, points, scope, unit, limit_seconds, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        type.name, type.points, type.scope, type.unit, type.limit_seconds, type.notes, index + 1,
      );
    });
  });
}

module.exports = { seedDatabase, randomAccessCode, CATEGORIES, DEDUCTION_TYPES };
