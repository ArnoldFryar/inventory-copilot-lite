'use strict';

// ---------------------------------------------------------------------------
// history routes — saved analysis run CRUD.
//
// POST   /api/runs             — save an analysis run
// GET    /api/runs             — list saved runs
// GET    /api/runs/:id/compare — compare run against predecessor
// GET    /api/runs/:id         — retrieve a single run
// DELETE /api/runs/:id         — delete a run
// ---------------------------------------------------------------------------

const express    = require('express');
const router     = express.Router();
const requireAuth = require('../middleware/requireAuth');
const {
  createRun,
  listRuns,
  compareRun,
  getRun,
  deleteRun
}                = require('../controllers/runController');

router.post('/api/runs',            requireAuth, createRun);
router.get('/api/runs',             requireAuth, listRuns);
// /compare MUST be before /:id so Express matches the literal segment first.
router.get('/api/runs/:id/compare', requireAuth, compareRun);
router.get('/api/runs/:id',         requireAuth, getRun);
router.delete('/api/runs/:id',      requireAuth, deleteRun);

module.exports = router;
