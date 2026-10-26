'use strict';

const { HttpError, isManagement } = require('./auth');

/**
 * Row-level access rules:
 *  - directors / office staff: everything
 *  - warehouse staff: all stock, requests and returns (they fulfil them)
 *  - account managers: their own clients and campaigns
 *  - promoters: campaigns they are assigned to, and their own requests/returns/stock
 */

function canSeeCampaign(db, user, campaign) {
  if (isManagement(user) || user.role === 'warehouse') return true;
  if (user.role === 'account_manager') return campaign.account_manager_id === user.id;
  if (user.role === 'promoter') {
    return !!db
      .prepare('SELECT 1 FROM campaign_promoters WHERE campaign_id = ? AND promoter_id = ?')
      .get(campaign.id, user.id);
  }
  return false;
}

/** Can this user manage (edit, approve stock for) the campaign? */
function canManageCampaign(user, campaign) {
  if (isManagement(user)) return true;
  return user.role === 'account_manager' && campaign.account_manager_id === user.id;
}

function assertCampaign(db, user, campaignId, { manage = false } = {}) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!campaign || !canSeeCampaign(db, user, campaign)) throw new HttpError(404, 'Campaign not found');
  if (manage && !canManageCampaign(user, campaign)) {
    throw new HttpError(403, 'Only the account manager or management can do this for the campaign');
  }
  return campaign;
}

/** SQL fragment + params restricting a query on alias `c` (campaigns) to what the user may see. */
function campaignScope(user, alias = 'c') {
  if (isManagement(user) || user.role === 'warehouse') return { sql: '1=1', params: [] };
  if (user.role === 'account_manager') return { sql: `${alias}.account_manager_id = ?`, params: [user.id] };
  return {
    sql: `EXISTS (SELECT 1 FROM campaign_promoters cp WHERE cp.campaign_id = ${alias}.id AND cp.promoter_id = ?)`,
    params: [user.id],
  };
}

/** SQL fragment restricting clients (alias `cl`) for account managers. */
function clientScope(user, alias = 'cl') {
  // Company-owned stock (tables, gazebos, JR uniforms) is shared by every campaign, so AMs see it too
  if (user.role === 'account_manager') return { sql: `(${alias}.account_manager_id = ? OR ${alias}.is_house = 1)`, params: [user.id] };
  return { sql: '1=1', params: [] };
}

module.exports = { canSeeCampaign, canManageCampaign, assertCampaign, campaignScope, clientScope };
