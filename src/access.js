'use strict';

const { HttpError, isManagement, isWarehouse } = require('./auth');

/**
 * Row-level access rules:
 *  - directors / office staff: everything
 *  - warehouse staff: all stock, requests and returns (they fulfil them)
 *  - account managers: their own clients and campaigns
 *  - promoters: campaigns they are assigned to, and their own requests/returns/stock
 */

async function canSeeCampaign(db, user, campaign) {
  if (isManagement(user) || isWarehouse(user)) return true;
  if (user.role === 'account_manager') return campaign.account_manager_id === user.id;
  if (user.role === 'promoter') {
    return !!(await db.get('SELECT 1 FROM campaign_promoters WHERE campaign_id = ? AND promoter_id = ?', campaign.id, user.id));
  }
  return false;
}

/** Can this user manage (edit, approve stock for) the campaign? */
function canManageCampaign(user, campaign) {
  if (isManagement(user)) return true;
  return user.role === 'account_manager' && campaign.account_manager_id === user.id;
}

async function assertCampaign(db, user, campaignId, { manage = false } = {}) {
  const campaign = (await db.get('SELECT * FROM campaigns WHERE id = ?', campaignId));
  if (!campaign || !await canSeeCampaign(db, user, campaign)) throw new HttpError(404, 'Campaign not found');
  if (manage && !canManageCampaign(user, campaign)) {
    throw new HttpError(403, 'Only the account manager or management can do this for the campaign');
  }
  return campaign;
}

/** SQL fragment + params restricting a query on alias `c` (campaigns) to what the user may see. */
function campaignScope(user, alias = 'c') {
  if (isManagement(user) || isWarehouse(user)) return { sql: '1=1', params: [] };
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
