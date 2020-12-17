const axios = require("axios");
const fs = require("fs");
const getFavicons = require("get-website-favicon");
const neatCsv = require("neat-csv");
const sqlite = require("sqlite");
const sqlite3 = require("sqlite3");
const util = require("util");

const copy = util.promisify(fs.copyFile);
const unlink = util.promisify(fs.unlink);

function getRandomDateInLastXDays(days) {
	return new Date(new Date().getTime() - 86400000 * Math.random() * days);
}

function shuffleArray(array) {
	// Source: https://stackoverflow.com/a/12646864/1438733
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
}

function toChromeTime(date) {
	// Converts a JS date to a Chrome "visit_time" timestamp.
	return (date.getTime() - new Date(1601, 0, 0).getTime()) * 1000;
}

function toDate(chromeTime) {
	// Converts a Chrome "visit_time" timestamp to a JS Date.
	return new Date(new Date(1601, 0, 0).getTime() + chromeTime / 1000);
}

async function openSqliteDb(file) {
	return sqlite.open({
		filename: file,
		driver: sqlite3.Database,
	});
}

async function addFavicon(db, url, date) {
	try {
		const urlData = new URL(url);
		const urlFaviconIndex = `${urlData.origin}/favicon.ico`;

		const existingFaviconRow = await db.get("SELECT * FROM favicons WHERE url=? LIMIT 1", [ urlFaviconIndex ]);

		let faviconId;

		if (existingFaviconRow) {
			faviconId = existingFaviconRow.id;
		} else {
			let suitableFaviconUrl = null;
			let suitableIconSize = 16;

			const favicons = await getFavicons(urlData.host);

			if (!favicons || !favicons.icons) {
				console.warn(`No favicons exist for '${urlData.host}'.`);

				return;
			}

			for (const icon of favicons.icons) {
				if (!icon.src.endsWith(".png")) {
					continue;
				}

				suitableFaviconUrl = icon.src;

				if (icon.sizes) {
					const iconSize = parseInt(icon.sizes, 10);

					suitableIconSize = iconSize;

					if (iconSize === 16 || iconSize === 32) {
						break;
					}
				}
			}

			if (!suitableFaviconUrl) {
				console.warn(`No suitable favicon exists for '${urlData.host}'.`);

				return;
			}

			const faviconResponse = await axios({
				method: "GET",
				responseType: "stream",
				url: suitableFaviconUrl,
			});

			const faviconTempPath = "output/__favicon_temp.png";
			const writer = fs.createWriteStream(faviconTempPath);

			faviconResponse.data.pipe(writer);

			const faviconRow = await db.get("SELECT * FROM favicons ORDER BY id DESC LIMIT 1");
			faviconId = faviconRow ? (faviconRow.id + 1) : 1;

			const faviconBitmapRow = await db.get("SELECT * FROM favicon_bitmaps ORDER BY id DESC LIMIT 1");
			const faviconBitmapId = faviconBitmapRow ? (faviconBitmapRow.id + 1) : 1;

			await db.run(
				"INSERT INTO favicons (id, url, icon_type) VALUES (?, ?, 1)",
				[ faviconId, urlFaviconIndex ],
			);

			await db.run(
				"INSERT INTO favicon_bitmaps (id, icon_id, last_updated, image_data, width, height) VALUES (?, ?, ?, ?, ?, ?)",
				[
					faviconBitmapId,
					faviconId,
					toChromeTime(date),
					fs.readFileSync(faviconTempPath),
					suitableIconSize,
					suitableIconSize,
				],
			);

			await unlink(faviconTempPath);
		}

		const iconMappingRow = await db.get("SELECT * FROM icon_mapping ORDER BY id DESC LIMIT 1");
		const iconMappingId = iconMappingRow ? (iconMappingRow.id + 1) : 1;

		await db.run(
			"INSERT INTO icon_mapping (id, page_url, icon_id) VALUES (?, ?, ?)",
			[ iconMappingId, url, faviconId ],
		);
	} catch (err) {
		console.error(err);
	}
}

async function addUrl(db, url, title, date) {
	try {
		const row = await db.get("SELECT * FROM urls ORDER BY id DESC LIMIT 1");
		const urlId = row ? (row.id + 1) : 1;

		await db.run(
			"INSERT INTO urls (id, url, title, last_visit_time) VALUES (?, ?, ?, ?)",
			[ urlId, url, title, toChromeTime(date) ],
		);

		await addVisit(db, urlId, date);
	} catch (err) {
		console.error(err);
	}
}

async function addVisit(db, urlId, date) {
	try {
		const row = await db.get("SELECT * FROM visits ORDER BY id DESC LIMIT 1");
		const visitId = row ? (row.id + 1) : 1;

		await db.run(
			"INSERT INTO visits (id, url, visit_time, transition, visit_duration) VALUES (?, ?, ?, 805306368, 24020632301)",
			[ visitId, urlId, toChromeTime(date) ],
		);
	} catch (err) {
		console.error(err);
	}
}

(async () => {
	const config = {
		// The maximum number of days in the past to add the history.
		daysBackToAdd: 7,

		// The number of historical entries to add.
		numberOfUrls: 10,

		// Add more sample CSV files here. Must be located in 'data/urls/[name].csv'.
		urlFilesToLoad: [ "sample" ],
	};

	const urls = [];

	for (const urlFileToLoad of config.urlFilesToLoad) {
		const urlFileContent = fs.readFileSync(`data/urls/${urlFileToLoad}.csv`);

		for (const urlRow of await neatCsv(urlFileContent)) {
			urls.push([ urlRow.url, urlRow.title ]);
		}
	}

	shuffleArray(urls);

	const urlsToAdd = urls.slice(0, config.numberOfUrls);

	const historyDbFile = "output/History";
	const faviconDbFile = "output/Favicons";

	for (const file of [ historyDbFile, faviconDbFile ]) {
		if (!fs.existsSync(file)) {
			continue;
		}

		await unlink(file);
	}

	await copy("data/templates/History", historyDbFile);
	await copy("data/templates/Favicons", faviconDbFile);

	const historyDb = await openSqliteDb(historyDbFile);
	const faviconDb = await openSqliteDb(faviconDbFile);

	for (const data of urlsToAdd) {
		const date = getRandomDateInLastXDays(config.daysBackToAdd);

		console.log("Adding", data[0], "with title", data[1], "on", date);

		await addUrl(historyDb, data[0], data[1], date);

		await addFavicon(faviconDb, data[0], date);
	}
})();
