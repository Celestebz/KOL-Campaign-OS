const express = require('express');

const router = express.Router();

const GONE_MESSAGE = 'Finder subtasks are removed in V2 per DEVELOPMENT_PLAN_V2. Use video evidence finder flow instead.';

router.get('/', (req, res) => res.status(410).json({ success: false, error: GONE_MESSAGE }));
router.get('/:id', (req, res) => res.status(410).json({ success: false, error: GONE_MESSAGE }));
router.post('/', (req, res) => res.status(410).json({ success: false, error: GONE_MESSAGE }));
router.put('/:id', (req, res) => res.status(410).json({ success: false, error: GONE_MESSAGE }));
router.delete('/:id', (req, res) => res.status(410).json({ success: false, error: GONE_MESSAGE }));
router.post('/:id/execute', (req, res) => res.status(410).json({ success: false, error: GONE_MESSAGE }));
router.post('/batch-execute', (req, res) => res.status(410).json({ success: false, error: GONE_MESSAGE }));

module.exports = router;
