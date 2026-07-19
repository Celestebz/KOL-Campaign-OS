'use strict';

const PRESERVATION_ERROR = 'Refusing to shrink finder video evidence raw_data because existing provider payloads may exceed MySQL TEXT capacity.';

module.exports = {
  async up(queryInterface, DataTypes) {
    await queryInterface.changeColumn('finder_video_evidence', 'raw_data', {
      type: DataTypes.TEXT('medium'),
      allowNull: true,
      comment: '来源返回的原始数据（JSON）'
    });
  },

  async down() {
    throw new Error(PRESERVATION_ERROR);
  }
};
