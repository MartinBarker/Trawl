// /trawl-schedule — turn an existing scan into a recurring job. The cadence is stored
// on scan_jobs.cron_expression and registered with the DB-persisted scheduler,
// so it survives restarts.
const { SlashCommandBuilder, ChannelType } = require('discord.js');
const db = require('../db');
const { rescheduleJob } = require('../lib/scheduler');

const PRESETS = {
  hourly: '0 * * * *',
  '6h': '0 */6 * * *',
  daily: '0 0 * * *',
  weekly: '0 0 * * 0',
  off: null,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trawl-schedule')
    .setDescription('Auto-run /trawl-makeplaylists for a channel on a recurring schedule')
    .addChannelOption(o =>
      o.setName('input_channel')
        .setDescription('The channel to re-scan')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true))
    .addStringOption(o =>
      o.setName('cadence')
        .setDescription('How often')
        .setRequired(true)
        .addChoices(
          { name: 'Every hour', value: 'hourly' },
          { name: 'Every 6 hours', value: '6h' },
          { name: 'Every day', value: 'daily' },
          { name: 'Every week', value: 'weekly' },
          { name: 'Turn off', value: 'off' }
        )),

  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
    }
    const inputChannel = interaction.options.getChannel('input_channel');
    const cadence = interaction.options.getString('cadence');
    const cronExpr = PRESETS[cadence];

    const { rows } = await db.query(
      `UPDATE scan_jobs
       SET cron_expression = $1, is_active = $2
       WHERE guild_id = $3 AND input_channel_id = $4
       RETURNING id`,
      [cronExpr, cronExpr !== null, interaction.guild.id, inputChannel.id]
    );
    if (rows.length === 0) {
      return interaction.reply({
        content: `No scan exists for ${inputChannel}. Run \`/trawl-makeplaylists\` first.`,
        ephemeral: true,
      });
    }

    for (const row of rows) await rescheduleJob(row.id, cronExpr);

    const label = cronExpr ? `**${cadence}** (\`${cronExpr}\` UTC)` : '**disabled**';
    await interaction.reply({
      content: `Scan for ${inputChannel} is now ${label}. ` +
        (cronExpr
          ? `I'll rescan and auto-push new links to YouTube if you've connected your account.`
          : `Auto-runs stopped.`),
      ephemeral: true,
    });
  },
};
