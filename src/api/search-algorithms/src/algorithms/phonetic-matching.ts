/**
 * Phonetic Matching Algorithms
 *
 * This module implements various phonetic matching algorithms that find
 * words that sound similar, even if they're spelled differently.
 *
 * Algorithms implemented:
 * - Soundex (classic phonetic algorithm)
 * - Metaphone (improved phonetic matching)
 * - Double Metaphone (handles multiple pronunciations)
 * - NYSIIS (New York State Identification and Intelligence System)
 */

export class PhoneticMatcher {
  /**
   * Soundex Algorithm
   *
   * Why: Classic phonetic algorithm, good for English names
   * When: Name matching, genealogy, customer databases
   * Time Complexity: O(n) where n is string length
   *
   * Rules:
   * 1. Keep first letter
   * 2. Replace consonants with digits (B,F,P,V=1; C,G,J,K,Q,S,X,Z=2; etc.)
   * 3. Remove vowels, H, W, Y
   * 4. Remove duplicate digits
   * 5. Pad with zeros or truncate to 4 characters
   */
  static soundex(str: string): string {
    // Keep only letters; the first letter drives the output character.
    const word = str.toUpperCase().replace(/[^A-Z]/g, "");
    if (word.length === 0) return "0000";

    let soundexCode = word[0];

    // Soundex digit mapping (vowels, H, W, Y intentionally absent).
    const soundexMap: { [key: string]: string } = {
      B: "1",
      F: "1",
      P: "1",
      V: "1",
      C: "2",
      G: "2",
      J: "2",
      K: "2",
      Q: "2",
      S: "2",
      X: "2",
      Z: "2",
      D: "3",
      T: "3",
      L: "4",
      M: "5",
      N: "5",
      R: "6",
    };

    // `prevCode` seeds from the FIRST letter so a same-coded second letter
    // is collapsed with it (e.g. "Pfister" -> P/F both map to 1 -> "P236").
    let prevCode = soundexMap[word[0]] || "";

    // H and W are transparent: two same-coded consonants separated by H/W are
    // coded once ("Ashcraft" -> A261). A VOWEL (or Y) is a true separator: it
    // resets `prevCode` so a repeat digit is coded again ("Tymczak" -> T522,
    // "Honeyman" -> H555).
    for (let i = 1; i < word.length && soundexCode.length < 4; i++) {
      const char = word[i];
      const code = soundexMap[char];

      if (code) {
        if (code !== prevCode) {
          soundexCode += code;
        }
        prevCode = code;
      } else if (char === "H" || char === "W") {
        // Transparent — leave prevCode untouched so H/W bridges same codes.
      } else {
        // Vowel or Y: acts as a separator, allowing the next repeat to code.
        prevCode = "";
      }
    }

    // Pad with zeros or truncate to 4 characters.
    return (soundexCode + "0000").substring(0, 4);
  }

  /**
   * Metaphone Algorithm
   *
   * Why: More accurate than Soundex for English words
   * When: Better phonetic matching for general English text
   * Time Complexity: O(n)
   */
  static metaphone(str: string): string {
    if (!str || str.length === 0) return "";

    const word = str.toUpperCase().replace(/[^A-Z]/g, "");
    if (word.length === 0) return "";

    let metaphoneCode = "";
    let i = 0;

    // Handle initial combinations
    if (
      word.startsWith("KN") ||
      word.startsWith("GN") ||
      word.startsWith("PN") ||
      word.startsWith("AE") ||
      word.startsWith("WR")
    ) {
      i = 1;
    }

    while (i < word.length) {
      const char = word[i];
      const nextChar = i + 1 < word.length ? word[i + 1] : "";
      const prevChar = i > 0 ? word[i - 1] : "";

      switch (char) {
        case "B":
          if (i === word.length - 1 && prevChar === "M") {
            // Silent B at end after M
          } else {
            metaphoneCode += "B";
          }
          break;

        case "C":
          if (prevChar === "S" && (nextChar === "H" || nextChar === "I" || nextChar === "E")) {
            // SCH, SCI, SCE
          } else if (nextChar === "H") {
            metaphoneCode += "X";
            i++; // Skip H
          } else if (nextChar === "I" || nextChar === "E" || nextChar === "Y") {
            metaphoneCode += "S";
          } else {
            metaphoneCode += "K";
          }
          break;

        case "D":
          if (nextChar === "G" && i + 2 < word.length && "EIY".includes(word[i + 2])) {
            metaphoneCode += "J";
            i += 2; // Skip DG
          } else {
            metaphoneCode += "T";
          }
          break;

        case "F":
          metaphoneCode += "F";
          break;

        case "G":
          if (nextChar === "H" && i + 2 < word.length && !"EIY".includes(word[i + 2])) {
            // Silent GH
          } else if (nextChar === "N" && i === word.length - 2) {
            // Silent GN at end
          } else if ("EIY".includes(nextChar)) {
            metaphoneCode += "J";
          } else {
            metaphoneCode += "K";
          }
          break;

        case "H":
          if (i === 0 || "AEIOU".includes(prevChar)) {
            if ("AEIOU".includes(nextChar)) {
              metaphoneCode += "H";
            }
          }
          break;

        case "J":
          metaphoneCode += "J";
          break;

        case "K":
          if (prevChar !== "C") {
            metaphoneCode += "K";
          }
          break;

        case "L":
          metaphoneCode += "L";
          break;

        case "M":
          metaphoneCode += "M";
          break;

        case "N":
          metaphoneCode += "N";
          break;

        case "P":
          if (nextChar === "H") {
            metaphoneCode += "F";
            i++; // Skip H
          } else {
            metaphoneCode += "P";
          }
          break;

        case "Q":
          metaphoneCode += "K";
          break;

        case "R":
          metaphoneCode += "R";
          break;

        case "S":
          if (
            nextChar === "H" ||
            (nextChar === "I" && i + 2 < word.length && "AO".includes(word[i + 2]))
          ) {
            metaphoneCode += "X";
            if (nextChar === "H") i++; // Skip H
          } else {
            metaphoneCode += "S";
          }
          break;

        case "T":
          if (nextChar === "H") {
            metaphoneCode += "0"; // TH sound
            i++; // Skip H
          } else if (nextChar === "I" && i + 2 < word.length && "AO".includes(word[i + 2])) {
            metaphoneCode += "X";
          } else {
            metaphoneCode += "T";
          }
          break;

        case "V":
          metaphoneCode += "F";
          break;

        case "W":
          if ("AEIOU".includes(nextChar)) {
            metaphoneCode += "W";
          }
          break;

        case "X":
          metaphoneCode += "KS";
          break;

        case "Y":
          if ("AEIOU".includes(nextChar)) {
            metaphoneCode += "Y";
          }
          break;

        case "Z":
          metaphoneCode += "S";
          break;

        // Vowels are generally ignored except at the beginning
        case "A":
        case "E":
        case "I":
        case "O":
        case "U":
          if (i === 0) {
            metaphoneCode += char;
          }
          break;
      }

      i++;
    }

    return metaphoneCode;
  }

  /**
   * NYSIIS (New York State Identification and Intelligence System)
   *
   * Why: Designed specifically for names, handles many edge cases
   * When: Name matching in databases, genealogy research
   * Time Complexity: O(n)
   */
  static nysiis(str: string): string {
    if (!str || str.length === 0) return "";

    let word = str.toUpperCase().replace(/[^A-Z]/g, "");
    if (word.length === 0) return "";

    // Step 1: Handle prefixes
    const prefixes = ["MAC", "KN", "K", "PH", "PF", "SCH"];
    for (const prefix of prefixes) {
      if (word.startsWith(prefix)) {
        switch (prefix) {
          case "MAC":
            word = "MCC" + word.substring(3);
            break;
          case "KN":
            word = "N" + word.substring(2);
            break;
          case "K":
            word = "C" + word.substring(1);
            break;
          case "PH":
          case "PF":
            word = "FF" + word.substring(2);
            break;
          case "SCH":
            word = "SSS" + word.substring(3);
            break;
        }
        break;
      }
    }

    // Step 2: Handle suffixes
    const suffixes = ["EE", "IE", "DT", "RT", "RD", "NT", "ND"];
    for (const suffix of suffixes) {
      if (word.endsWith(suffix)) {
        switch (suffix) {
          case "EE":
          case "IE":
            word = word.substring(0, word.length - 2) + "Y";
            break;
          case "DT":
          case "RT":
          case "RD":
          case "NT":
          case "ND":
            word = word.substring(0, word.length - 2) + "D";
            break;
        }
        break;
      }
    }

    // Step 3: First character of key = first character of name
    let nysiisCode = word[0];

    // Step 4: Process remaining characters
    for (let i = 1; i < word.length; i++) {
      const char = word[i];
      const prevChar = word[i - 1];
      const nextChar = i + 1 < word.length ? word[i + 1] : "";

      let replacement = "";

      switch (char) {
        case "A":
        case "E":
        case "I":
        case "O":
        case "U":
        case "Y":
          replacement = "A";
          break;
        case "Q":
          replacement = "G";
          break;
        case "Z":
          replacement = "S";
          break;
        case "M":
          replacement = "N";
          break;
        case "K":
          if (nextChar === "N") {
            replacement = "N";
          } else {
            replacement = "C";
          }
          break;
        case "S":
          if (nextChar === "C" && i + 2 < word.length && word[i + 2] === "H") {
            replacement = "SSS";
          } else {
            replacement = "S";
          }
          break;
        case "P":
          if (nextChar === "H") {
            replacement = "F";
          } else {
            replacement = "P";
          }
          break;
        case "H":
          if (!"AEIOU".includes(prevChar) || !"AEIOU".includes(nextChar)) {
            replacement = prevChar;
          } else {
            replacement = "H";
          }
          break;
        case "W":
          if ("AEIOU".includes(prevChar)) {
            replacement = prevChar;
          } else {
            replacement = "W";
          }
          break;
        default:
          replacement = char;
      }

      // Add to code if different from last character
      if (replacement && replacement !== nysiisCode[nysiisCode.length - 1]) {
        nysiisCode += replacement;
      }
    }

    // Step 5: Remove trailing 'S'
    if (nysiisCode.endsWith("S") && nysiisCode.length > 1) {
      nysiisCode = nysiisCode.substring(0, nysiisCode.length - 1);
    }

    // Step 6: Replace trailing 'AY' with 'Y'
    if (nysiisCode.endsWith("AY")) {
      nysiisCode = nysiisCode.substring(0, nysiisCode.length - 2) + "Y";
    }

    // Step 7: Remove trailing 'A'
    if (nysiisCode.endsWith("A") && nysiisCode.length > 1) {
      nysiisCode = nysiisCode.substring(0, nysiisCode.length - 1);
    }

    return nysiisCode.substring(0, 6); // Limit to 6 characters
  }

  /**
   * Double Metaphone (simplified version)
   *
   * Why: Handles multiple possible pronunciations of words
   * When: More accurate phonetic matching for diverse names
   * Note: This is a simplified implementation of the full Double Metaphone
   */
  static doubleMetaphone(str: string): { primary: string; secondary: string } {
    // For this example, we'll return the regular metaphone as primary
    // and a variant as secondary. A full implementation would be much more complex.
    const primary = this.metaphone(str);

    // Simple secondary variant: handle some common alternatives
    let word = str.toUpperCase();

    // Handle some common variations
    word = word.replace(/PH/g, "F");
    word = word.replace(/GH/g, "F");
    word = word.replace(/CK/g, "K");

    const secondary = this.metaphone(word);

    return { primary, secondary: secondary !== primary ? secondary : "" };
  }

  /**
   * Phonetic matching with configurable algorithm
   *
   * Why: Provides a unified interface for different phonetic algorithms
   * When: You want to experiment with different phonetic matching approaches
   */
  static phoneticMatch(
    text: string,
    query: string,
    algorithm: "soundex" | "metaphone" | "nysiis" | "doubleMetaphone" = "metaphone"
  ): { matches: boolean; codes: { text: string; query: string } } {
    let textCode: string;
    let queryCode: string;

    switch (algorithm) {
      case "soundex":
        textCode = this.soundex(text);
        queryCode = this.soundex(query);
        break;
      case "metaphone":
        textCode = this.metaphone(text);
        queryCode = this.metaphone(query);
        break;
      case "nysiis":
        textCode = this.nysiis(text);
        queryCode = this.nysiis(query);
        break;
      case "doubleMetaphone": {
        const textDM = this.doubleMetaphone(text);
        const queryDM = this.doubleMetaphone(query);

        // Check if either primary or secondary codes match
        const matches =
          textDM.primary === queryDM.primary ||
          textDM.primary === queryDM.secondary ||
          textDM.secondary === queryDM.primary ||
          (!!textDM.secondary && !!queryDM.secondary && textDM.secondary === queryDM.secondary);

        return {
          matches,
          codes: {
            text: `${textDM.primary}${textDM.secondary ? "|" + textDM.secondary : ""}`,
            query: `${queryDM.primary}${queryDM.secondary ? "|" + queryDM.secondary : ""}`,
          },
        };
      }
      default:
        textCode = this.metaphone(text);
        queryCode = this.metaphone(query);
    }

    return {
      matches: textCode === queryCode,
      codes: { text: textCode, query: queryCode },
    };
  }

  /**
   * Phonetic similarity score
   *
   * Why: Provides a similarity score rather than just a boolean match
   * When: You need to rank phonetic matches by similarity
   */
  static phoneticSimilarity(
    text: string,
    query: string,
    algorithm: "soundex" | "metaphone" | "nysiis" = "metaphone"
  ): number {
    const result = this.phoneticMatch(text, query, algorithm);

    if (result.matches) {
      return 1.0;
    }

    // Calculate partial similarity based on code similarity
    const textCode = result.codes.text;
    const queryCode = result.codes.query;

    if (textCode.length === 0 || queryCode.length === 0) {
      return 0.0;
    }

    // Use Levenshtein distance on the phonetic codes
    const maxLen = Math.max(textCode.length, queryCode.length);
    const distance = this.levenshteinDistance(textCode, queryCode);

    return 1 - distance / maxLen;
  }

  /**
   * Simple Levenshtein distance for phonetic codes
   */
  private static levenshteinDistance(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]) + 1;
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Batch phonetic encoding
   *
   * Why: Efficiently encode multiple strings for phonetic matching
   * When: Building phonetic indexes or processing large datasets
   */
  static batchEncode(
    strings: string[],
    algorithm: "soundex" | "metaphone" | "nysiis" = "metaphone"
  ): Map<string, string> {
    const results = new Map<string, string>();

    for (const str of strings) {
      let code: string;

      switch (algorithm) {
        case "soundex": {
          code = this.soundex(str);
          break;
        }
        case "metaphone": {
          code = this.metaphone(str);
          break;
        }
        case "nysiis": {
          code = this.nysiis(str);
          break;
        }
        default: {
          code = this.metaphone(str);
        }
      }

      results.set(str, code);
    }

    return results;
  }
}
