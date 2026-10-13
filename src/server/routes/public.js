'use strict';

const express = require('express');

/** Unauthenticated endpoints: just enough for the judge sign-in screen. */
module.exports = function publicRoutes({ db }) {
  const router = express.Router();

  router.get('/info', (req, res) => {
    const settings = Object.fromEntries(db.all('SELECT key, value FROM settings').map((row) => [row.key, row.value]));
    res.json({
      eventName: settings.event_name || '',
      eventSubtitle: settings.event_subtitle || '',
      judges: db.all('SELECT id, judge_no, name FROM judges ORDER BY judge_no'),
    });
  });

  return router;
};
