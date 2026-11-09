// Preserve explicit human blocks and active human-created rules. Recover only AI decisions.
module.exports = {
  async up(q) {
    await q.sequelize.transaction(async transaction => {
      await q.sequelize.query(`UPDATE email_replies r INNER JOIN email_filter_rules f
        ON f.owner_user_id = r.owner_user_id AND f.active = 1
        AND ((f.rule_type = 'sender' AND f.rule_value = LOWER(TRIM(r.from_address)))
          OR (f.rule_type = 'domain' AND f.rule_value = SUBSTRING_INDEX(LOWER(TRIM(r.from_address)), '@', -1)))
        SET r.classification_source = 'rule',
          r.classification_reason = '命中人工创建的屏蔽规则，保留屏蔽', r.updated_at = NOW()
        WHERE r.classification = 'spam' AND r.classification_source = 'ai' AND r.spam_marked_by IS NULL`, { transaction });
      await q.sequelize.query(`UPDATE email_replies r SET
        r.classification = 'needs_review', r.classification_source = 'system',
        r.classification_reason = CONCAT('已取消旧 AI 自动屏蔽，待人工确认。原 AI 判断仅供复核：', LEFT(COALESCE(r.classification_reason, ''), 1500)),
        r.confirm_status = CASE WHEN r.confirm_status = 'spam' THEN 'pending' ELSE r.confirm_status END,
        r.triage_status = CASE WHEN r.triage_status = 'success' OR r.todo_status = 'done'
          OR r.confirm_status IN ('ignored', 'manually_replied') THEN r.triage_status ELSE 'manual_review' END,
        r.business_category = COALESCE(r.business_category, 'needs_review'),
        r.business_priority = COALESCE(r.business_priority, 'important'),
        r.todo_enqueued_at = COALESCE(r.todo_enqueued_at, NOW()),
        r.todo_status = CASE WHEN r.todo_status = 'done' OR r.confirm_status IN ('ignored', 'manually_replied') THEN 'done' ELSE 'pending' END,
        r.triage_lease = NULL, r.triage_lease_until = NULL, r.updated_at = NOW()
        WHERE r.classification = 'spam' AND r.classification_source = 'ai' AND r.spam_marked_by IS NULL
          AND NOT EXISTS (SELECT 1 FROM email_filter_rules f WHERE f.owner_user_id = r.owner_user_id AND f.active = 1
            AND ((f.rule_type = 'sender' AND f.rule_value = LOWER(TRIM(r.from_address)))
              OR (f.rule_type = 'domain' AND f.rule_value = SUBSTRING_INDEX(LOWER(TRIM(r.from_address)), '@', -1))))`, { transaction });
    });
  },
  async down() { throw new Error('不自动重新屏蔽已恢复邮件；保留人工复核记录。'); }
};
