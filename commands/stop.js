// /trawl-stop — disable all scheduled scans in this server. Clears the cron on each
// scan_job and unregisters it from the scheduler.
const { SlashCommandBuilder } = require('discord.js');
const db = require('../db');
const { rescheduleJob } = require('../lib/scheduler');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trawl-stop')
    .setDescription('Stop all scheduled scans in this server'),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
    }

    const { rows } = await db.query(
      `UPDATE scan_jobs
       SET cron_expression = NULL, is_active = false
       WHERE guild_id = $1 AND cron_expression IS NOT NULL
       RETURNING id`,
      [interaction.guild.id]
    );

    for (const row of rows) await rescheduleJob(row.id, null);

    if (rows.length === 0) {
      return interaction.reply({ content: 'No scheduled scans found in this server.', ephemeral: true });
    }
    await interaction.reply({
      content: `Stopped ${rows.length} scheduled scan${rows.length === 1 ? '' : 's'}.`,
      ephemeral: true,
    });
    console.log(`[Stop] Cleared ${rows.length} scheduled job(s) in guild ${interaction.guild.id}`);
  },
};
