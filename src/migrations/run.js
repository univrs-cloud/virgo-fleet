(async () => {
	console.log(`Post install running...`);
	try {
		console.log(`Post install completed successfully!`);
	} catch (error) {
		console.error(`Post install failed:`, error);
	}
})();
