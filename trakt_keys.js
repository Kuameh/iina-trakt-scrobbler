var CLIENT_ID_B64 = [
	"Nzc5YTIzZTkwNWY5NDMzNDFk",
	"YTIyYTM0ZjlkNTc5NWEyZjdh",
	"MGQwZTBhMTRkOTk1MWE5NDlk",
	"ODIwNWJlMDRmMA==",
].join("");
var CLIENT_SECRET_B64 = [
	"NzY2OGI3NzUyNTdlMTJkNjA3",
	"ZDM0NzI2OTAxOGUyMWMwODg2",
	"MWQ5OWEyZWYzM2NjMDA5YTJl",
	"NzBhNTMwNWE4MQ==",
].join("");

function clean(value) {
	return String(value || "").trim();
}

function decodeBase64(value) {
	var input = clean(value).replace(/=+$/g, "");
	if (!input) {
		return "";
	}

	var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	var output = "";
	var buffer = 0;
	var bits = 0;

	for (var index = 0; index < input.length; index += 1) {
		var code = alphabet.indexOf(input.charAt(index));
		if (code < 0) {
			continue;
		}

		buffer = (buffer << 6) | code;
		bits += 6;

		if (bits >= 8) {
			bits -= 8;
			output += String.fromCharCode((buffer >> bits) & 0xff);
		}
	}

	return output;
}

module.exports = {
	getId: function () {
		return clean(decodeBase64(CLIENT_ID_B64));
	},
	getSecret: function () {
		return clean(decodeBase64(CLIENT_SECRET_B64));
	},
	hasEmbeddedCredentials: function () {
		return !!(
			clean(decodeBase64(CLIENT_ID_B64)) &&
			clean(decodeBase64(CLIENT_SECRET_B64))
		);
	},
};
