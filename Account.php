<?php

	require_once('DB.php');
	require_once('LoginException.php');

	class Account extends DB {
		const SEARCH_RESULT_LIMIT = 10;
		const CUSTOM_NUMBER_LIMIT = 10000;

		private static int $account = -1;
		private static string $mail;

		static function init() : void {
			self::$account = intval($_SESSION['account']);
			self::$mail = $_SESSION['mail'];
		}

		/**
		 * @throws LoginException
		 */
		public static function checkLogin() {
			if(self::$account < 0) {
				throw new LoginException('Not logged in');
			}
		}

		public static function login(string $mail, string $license) : bool {
			$loggedIn = false;

			$stmt = self::prepare('
				SELECT 1
				FROM `account`
				WHERE `license` = ?
				AND `mail` = ?
			');

			$stmt->bind_param('ss', $license, $mail);
			$stmt->execute();

			if($stmt->fetch()) {
				$_SESSION['account'] = $license;
				$_SESSION['mail'] = $mail;

				self::init();
				$loggedIn = true;
			}

			$stmt->close();

			return $loggedIn;
		}

		public static function logout() {
			session_unset();
			session_destroy();
		}

		public static function getAccount() : int {
			return self::$account;
		}

		/**
		 * @return int
		 * @throws LoginException
		 */
		public static function getNextSongIndex() : int {
			self::checkLogin();

			$stmt = self::prepare('
				SELECT MAX(`songnumber`) + 1
				FROM `songs`
				WHERE `songnumber` < ' . self::CUSTOM_NUMBER_LIMIT . '
				AND `account` = ?
			');

			$stmt->bind_param('i', $_SESSION['account']);
			$stmt->execute();
			$stmt->bind_result($songIndex);

			$index = -1;

			if($stmt->fetch()) {
				$index = $songIndex;
			}

			$stmt->close();

			return $index;
		}

		/**
		 * @param string $search
		 * @return string
		 * @throws LoginException
		 */
		private static function prepareSearchParameter(string  $search) : string {
			self::checkLogin();

			$result = [];

			foreach(explode(' ', $search) as $word) {
				array_push($result, '("' . $word . '" ' . $word . '*)');
			}

			return join(' ', $result);
		}

		/**
		 * @param string $order lexicographic | numeric
		 * @return array
		 * @throws LoginException
		 */
		public static function searchAll(string $order = 'lexicographic') : array {
			self::checkLogin();

			switch($order) {
				case 'numeric':
					$order = 'songnumber';
					break;
				default:
					$order = 'title';
			}

			$stmt = self::prepare('
				SELECT `songnumber`, `title`
				FROM `songs`
				WHERE `account` = ?
				ORDER BY `' . $order . '` ASC
			');

			$stmt->bind_param('i', self::$account);
			$stmt->execute();
			$stmt->bind_result($songNumber, $title);

			$result = [];
			while($stmt->fetch()) {
				array_push($result, [
					'songNumber' => $songNumber,
					'title' => $title
				]);
			}

			$stmt->close();

			return $result;
		}

		/**
		 * @param string $title
		 * @return array
		 * @throws LoginException
		 */
		public static function searchTitle(string $title) : array {
			self::checkLogin();

			$search = self::prepareSearchParameter($title);

			$stmt = self::prepare('
				SELECT *
				FROM (
					SELECT `songnumber`, `title`, MATCH(`title`) AGAINST (? IN BOOLEAN MODE) AS score
					FROM `songs`
					WHERE `account` = ?
					ORDER BY `score` DESC, `title` ASC
				) t
				WHERE t.score > 0
				LIMIT ' . self::SEARCH_RESULT_LIMIT . '
			');

			$stmt->bind_param('si', $search, self::$account);
			$stmt->execute();
			$stmt->bind_result($songNumber, $title, $score);

			$result = [];
			while($stmt->fetch()) {
				array_push($result, [
					'songNumber' => $songNumber,
					'title' => $title
				]);
			}

			$stmt->close();

			return $result;
		}

		/**
		 * @param int $songNumber
		 * @return array
		 * @throws LoginException
		 */
		public static function searchSongNumber(int $songNumber) : array {
			self::checkLogin();

			$search = $songNumber . '%';

			$stmt = self::prepare('
				SELECT `songnumber`, `title`
				FROM `songs`
				WHERE CAST(`songnumber` AS CHAR) LIKE(?)
				AND `account` = ?
				ORDER BY `songnumber`
				LIMIT ' . self::SEARCH_RESULT_LIMIT . '
			');

			$stmt->bind_param('si', $search, self::$account);
			$stmt->execute();
			$stmt->bind_result($songNumber, $title);

			$result = [];
			while($stmt->fetch()) {
				array_push($result, [
					'songNumber' => $songNumber,
					'title' => $title
				]);
			}

			$stmt->close();

			return $result;
		}

		/**
		 * @param $text
		 * @return array
		 * @throws LoginException
		 */
		public static function searchText($text) : array {
			self::checkLogin();

			$search = self::prepareSearchParameter($text);

			$stmt = self::prepare('
				SELECT `songnumber`, `title`, AVG(`score`) as `score` 
				FROM (
					SELECT `songs`.`songnumber`, `songs`.`title`, MATCH(`blocks`.`text`) AGAINST (? IN BOOLEAN MODE) AS score
					FROM `songs`
					INNER JOIN `blocks` ON `songs`.`songnumber` = `blocks`.`songnumber` AND `blocks`.`account` = ?
					/*WHERE `songs`.`account` = ?*/
				) t
				GROUP BY `songnumber`, `title`
				HAVING score > 0
				ORDER BY `score` DESC, `title` ASC
				LIMIT ' . self::SEARCH_RESULT_LIMIT . '
			');

			echo self::error();

			//$stmt->bind_param('sii', $search, self::$account, self::$account);
			$stmt->bind_param('si', $search, self::$account);
			$stmt->execute();
			$stmt->bind_result($songNumber, $title, $score);

			$result = [];
			while($stmt->fetch()) {
				array_push($result, [
					'songNumber' => $songNumber,
					'title' => $title
				]);
			}

			$stmt->close();

			return $result;
		}

		/**
		 * @param string $show
		 * @param string $order
		 * @throws LoginException
		 */
		public static function saveShow(string $show, string $order) {
			self::checkLogin();

			$stmt = self::prepare('
				REPLACE INTO `shows` (
					`account`, `title`, `order`
				) VALUES (
					?, ?, ?
				)			
			');

			$stmt->bind_param('iss', self::$account, $show, $order);
			$stmt->execute();
			$stmt->close();
		}

		/**
		 * @param int $limit
		 * @return array
		 * @throws LoginException
		 */
		public static function getShows(int $limit = 30) : array {
			self::checkLogin();

			$stmt = self::prepare('
				SELECT `title`
				FROM `shows`
				WHERE `account` = ?
				ORDER BY `date` DESC
				LIMIT ?
			');

			$stmt->bind_param('ii', self::$account, $limit);
			$stmt->execute();
			$stmt->bind_result($title);

			$shows = [];

			while($stmt->fetch()) {
				array_push($shows, $title);
			}

			$stmt->close();

			return $shows;
		}

		/**
		 * @param string $title
		 * @return array|false
		 * @throws LoginException
		 */
		public static function getShow(string $title) {
			self::checkLogin();

			$stmt = self::prepare('
				SELECT `order`
				FROM `shows`
				WHERE `account` = ?
				AND `title` = ?
			');

			$result = false;

			$stmt->bind_param('is', self::$account, $title);
			$stmt->execute();
			$stmt->bind_result($order);

			if($stmt->fetch()) {
				$result = [
					'order' => explode(',', $order)
				];
			}

			$stmt->close();

			return $result;
		}

		/**
		 * @param $title
		 * @throws LoginException
		 */
		public static function deleteShow($title) {
			self::checkLogin();

			$stmt = self::prepare('
				DELETE FROM `shows`
				WHERE `account` = ?
				AND `title` = ?
			');

			$stmt->bind_param('is', self::$account, $title);
			$stmt->execute();
			$stmt->close();
		}
	}

	session_start();

	if(isset($_SESSION['account']) && isset($_SESSION['mail'])) {
		Account::init();
	}
