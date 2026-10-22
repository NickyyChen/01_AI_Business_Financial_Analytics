'use strict';

const DELIVERY_ACTIVE_STATUSES = ['履约中', '已结案', '预计新签'];

function isDeliveryActiveStatus(status) {
  return DELIVERY_ACTIVE_STATUSES.includes(String(status || '').trim());
}

module.exports = {
  DELIVERY_ACTIVE_STATUSES,
  isDeliveryActiveStatus,
};
